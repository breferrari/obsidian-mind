/**
 * Which notes this vault serves, on every surface.
 *
 * The default is the vault's own `user_content_roots` — the user's notes, read
 * by the user's own session. `mcp_exposed_roots` narrows that, and exists for a
 * vault holding material that is not the user's to share.
 *
 * A note is served when all three hold:
 *
 *   1. its path is inside an exposed root
 *   2. its filename is not in the never-expose list
 *   3. it is not tagged `private` in frontmatter
 *
 * Every read surface resolves through this module rather than walking the vault
 * itself, so `search`, `expand` and the resource enumerators cannot disagree
 * about which notes exist. A surface that reads the filesystem directly is the
 * defect this module is shaped to prevent.
 */

import { readdirSync, statSync, lstatSync, existsSync, realpathSync } from "node:fs";
import { join, basename, resolve, sep } from "node:path";


import { vaultRelKey } from "./mcp-qmd-client.ts";
import { readHead } from "./read-head.ts";

/** How deep to walk inside an exposed root. */
const MAX_DEPTH = 4;
/** How much of a file to read when probing its frontmatter. */
const HEAD_BYTES = 1200;

export interface ExposurePolicy {
	/** Path prefixes whose notes are served. */
	readonly roots: readonly string[];
	/** Filenames withheld regardless of folder. */
	readonly neverExpose: ReadonlySet<string>;
	/** Where the root list came from, for `health` to report. */
	readonly source: "manifest" | "derived" | "fallback";
	/** The memory root, excluded from every read surface unconditionally. */
	readonly memoryRoot: string;
}

export interface VisibleFile {
	readonly full: string;
	readonly label: string;
	/** The exposed root this file was reached through. */
	readonly scope: string;
}

export interface ResourceDef {
	readonly uri: string;
	readonly name: string;
	readonly description: string;
	readonly mimeType: string;
}

/** Used only when the manifest declares neither exposure key. */
const FALLBACK_ROOTS: readonly string[] = ["brain", "reference"];

/**
 * Normalise a declared root. Path PREFIXES are allowed, not just top-level
 * names, because that is the granularity the vault already speaks in:
 * `user_content_roots` says `work/active/`, not `work/`. Collapsing to the top
 * segment would expose `work/1-1/` because `work/active/` was declared, which
 * is both wrong and not what the user wrote down.
 *
 * Traversal is refused; a trailing slash and a leading `./` are tolerated
 * because the manifest is written by humans.
 */
function cleanRoots(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const raw of value) {
		if (typeof raw !== "string") continue;
		const trimmed = raw.trim().replace(/^\.\//, "");
		// A trailing slash marks the last segment as a FOLDER; without one it is a
		// file pattern. That distinction decides how a glob is handled.
		const endsInFolder = /[\\/]$/.test(trimmed);
		const s = trimmed.replace(/^[\\/]+|[\\/]+$/g, "");
		if (!s) continue;
		const parts = s.split(/[\\/]/);
		if (parts.some((p) => p === "." || p === "..")) continue;

		const globAt = parts.findIndex((p) => p.includes("*"));
		if (globAt < 0) {
			out.push(parts.join("/"));
			continue;
		}
		// `brain/*.md` — a file pattern, so the parent folder is what was meant.
		// `perf/h*-*/` — a set of FOLDERS under perf. Truncating that to `perf`
		// would serve every folder under it, which is more than the vault
		// declared, so the entry is dropped instead.
		if (!endsInFolder && globAt === parts.length - 1 && globAt > 0) {
			out.push(parts.slice(0, globAt).join("/"));
		}
	}
	return [...new Set(out)];
}

/**
 * Memories are never served as ordinary notes, whatever the config says. They
 * carry their own declared scope, evaluated per caller; reaching them through
 * the note surface would bypass it.
 */
function withoutMemoryRoot(roots: readonly string[], memoryRoot: string): string[] {
	const mem = memoryRoot.toLowerCase();
	return roots.filter((r) => r.toLowerCase() !== mem && !r.toLowerCase().startsWith(`${mem}/`));
}

/** Keep only roots that exist on disk, so the listing reflects the vault. */
function present(vaultRoot: string, roots: readonly string[]): string[] {
	return roots.filter((r) => {
		try {
			return statSync(join(vaultRoot, r)).isDirectory();
		} catch {
			return false;
		}
	});
}

/**
 * Which folders this vault serves.
 *
 * `mcp_exposed_roots` when declared, otherwise the vault's own
 * `user_content_roots` — the user's notes, read by the user's own session. A
 * vault holding material that is not the user's to share (employer-confidential
 * notes, client data) narrows it explicitly.
 */
export function resolveExposure(
	vaultRoot: string,
	manifest: Record<string, unknown> | null | undefined,
	memoryRoot = "memories",
): ExposurePolicy {
	// Filenames, not folder names — spaces and dots are legitimate here.
	const never = new Set(
		Array.isArray(manifest?.mcp_never_expose)
			? manifest.mcp_never_expose.filter((s): s is string => typeof s === "string")
			: [],
	);

	const declared = cleanRoots(manifest?.mcp_exposed_roots);
	if (declared.length) {
		return { roots: withoutMemoryRoot(declared, memoryRoot), neverExpose: never, source: "manifest", memoryRoot };
	}

	const derived = present(vaultRoot, cleanRoots(manifest?.user_content_roots));
	if (derived.length) {
		return { roots: withoutMemoryRoot(derived, memoryRoot), neverExpose: never, source: "derived", memoryRoot };
	}

	const fallback = present(vaultRoot, FALLBACK_ROOTS);
	return {
		roots: withoutMemoryRoot(fallback.length ? fallback : [...FALLBACK_ROOTS], memoryRoot),
		neverExpose: never,
		source: "fallback",
		memoryRoot,
	};
}

/**
 * Is this note marked private?
 *
 * An UNREADABLE file returns true, so a file whose frontmatter cannot be
 * inspected is not served — a permissions error must not resolve to "not
 * private".
 */
export function isPrivate(path: string): boolean {
	const head = readHead(path, HEAD_BYTES);
	if (head === null) return true;
	return /^\s*-?\s*private\s*$/m.test(head) || /^private:\s*true/m.test(head);
}

/** Pull the frontmatter `description:` so a resource list is self-describing. */
export function firstDescription(path: string, fallback = "Vault note"): string {
	const head = readHead(path, HEAD_BYTES);
	if (head === null) return fallback;
	const m = head.match(/^description:\s*"?(.+?)"?\s*$/m);
	return m?.[1] ? m[1].slice(0, 200) : fallback;
}

/**
 * Does `path` resolve to something inside `rootReal`?
 *
 * `realpath` follows symlinks all the way, so this is the check that decides
 * whether a link stays inside the root it was reached through. A broken link
 * throws and is refused: a path that cannot be resolved is not served.
 */
function containedIn(rootReal: string, path: string): boolean {
	try {
		const real = realpathSync(resolve(path));
		return real === rootReal || real.startsWith(rootReal + sep);
	} catch {
		return false;
	}
}

/** The declared root that admits `rel`, at the granularity the manifest wrote it. */
function matchedRoot(policy: ExposurePolicy, rel: string): string | null {
	const lower = rel.replace(/\\/g, "/").toLowerCase();
	return (
		policy.roots.find((r) => {
			const root = r.toLowerCase();
			return lower === root || lower.startsWith(`${root}/`);
		}) ?? null
	);
}

/** Is `rel` inside one of the policy's exposed roots? */
export function isExposedPath(policy: ExposurePolicy, relPath: string): boolean {
	const rel = relPath.replace(/\\/g, "/").toLowerCase();
	if (!rel) return false;
	const mem = policy.memoryRoot?.toLowerCase();
	if (mem && (rel === mem || rel.startsWith(`${mem}/`))) return false;
	// Prefix match on whole segments, so `work/active` does not admit
	// `work/active-secrets` and `brain` admits `brain/sub/note.md`.
	return policy.roots.some((r) => {
		const root = r.toLowerCase();
		return rel === root || rel.startsWith(`${root}/`);
	});
}

/**
 * Every note this vault will expose, on any surface.
 *
 * This is the single source of truth. `search` filters its hits against it,
 * `expand` computes backlinks only over it, and the resource enumerators build
 * from it — so a note cannot be absent from one surface and present on another.
 *
 * Symlinks are resolved and contained DURING the walk, not only when a URI is
 * read back. `statSync` follows a link silently, so enumerating with it meant a
 * `.md` link inside an exposed root pulled in a file from anywhere on disk:
 * `listResources` published its description, `allowedSearchPaths` accepted it,
 * and `expand` read its body — while `resolveResourceUri` refused the very same
 * path. Two read paths disagreeing is the one thing this module exists to stop.
 */
export function visibleFiles(vaultRoot: string, policy: ExposurePolicy): VisibleFile[] {
	const files: VisibleFile[] = [];

	const walk = (dir: string, scope: string, rootReal: string, depth: number): void => {
		if (depth > MAX_DEPTH || !existsSync(dir)) return;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const f of entries) {
			if (f.startsWith(".")) continue;
			const full = join(dir, f);
			let isDir: boolean;
			try {
				// lstat describes the ENTRY; stat describes what it points at. The
				// difference is the whole check: a link is contained before it is
				// followed, and an ordinary entry costs no extra syscall.
				const entry = lstatSync(full);
				if (entry.isSymbolicLink()) {
					if (!containedIn(rootReal, full)) continue;
					isDir = statSync(full).isDirectory();
				} else {
					isDir = entry.isDirectory();
				}
			} catch {
				continue;
			}
			if (isDir) {
				walk(full, scope, rootReal, depth + 1);
				continue;
			}
			if (!f.endsWith(".md")) continue;
			if (policy.neverExpose.has(f)) continue;
			if (isPrivate(full)) continue;
			files.push({ full, label: basename(f, ".md"), scope });
		}
	};

	for (const root of policy.roots) {
		// Belt and braces: resolveExposure already strips it, but a hand-built
		// policy must not be able to walk the memory store into the read surface.
		if (policy.memoryRoot && root.toLowerCase() === policy.memoryRoot.toLowerCase()) continue;
		const dir = join(vaultRoot, root);
		let rootReal: string;
		try {
			rootReal = realpathSync(resolve(dir));
		} catch {
			continue; // the root does not exist, or is itself a broken link
		}
		walk(dir, root, rootReal, 0);
	}
	return files;
}

/**
 * The set `search` filters against — vault-relative keys of every visible file.
 *
 * Derived from `visibleFiles` rather than computed separately, because two
 * independent implementations of "what may this caller see" is how the surfaces
 * drifted apart in the first place.
 */
export function allowedSearchPaths(vaultRoot: string, policy: ExposurePolicy): Set<string> {
	return new Set(visibleFiles(vaultRoot, policy).map((f) => vaultRelKey(vaultRoot, f.full)));
}

/**
 * Notes offered as MCP resources, so a session can list what knowledge exists
 * and read one directly when its title already answers the question — cheaper
 * and more exact than a search.
 *
 * Built from `visibleFiles` rather than from a walk of its own, so a vault that
 * narrows `mcp_exposed_roots` gets that narrowing here too. An enumerator that
 * reads known folders directly ignores the setting entirely.
 */
export function listResources(vaultRoot: string, policy: ExposurePolicy): ResourceDef[] {
	return visibleFiles(vaultRoot, policy).map((f) => {
		const rel = vaultRelKeyRaw(vaultRoot, f.full);
		return {
			uri: `vault://note/${rel.split("/").map(encodeURIComponent).join("/")}`,
			name: f.scope === f.label ? f.label : `${f.scope}: ${f.label}`,
			description: firstDescription(f.full),
			mimeType: "text/markdown",
		};
	});
}

/**
 * Vault-relative path with case and spacing PRESERVED.
 *
 * `vaultRelKey` deliberately normalises for comparison; a URI must round-trip to
 * a real file, so it needs the original.
 */
export function vaultRelKeyRaw(vaultRoot: string, full: string): string {
	const v = vaultRoot.replace(/\\/g, "/").replace(/\/+$/, "");
	const p = full.replace(/\\/g, "/");
	return p.toLowerCase().startsWith(v.toLowerCase()) ? p.slice(v.length).replace(/^\/+/, "") : p;
}

/**
 * Resolve a `vault://note/<rel>` URI back to a file, re-applying the policy.
 *
 * Re-checked rather than trusted: a URI is caller-supplied input, and the fact
 * that this server minted one earlier is not evidence that THIS one resolves
 * inside the policy. Anything outside it returns null, which the caller reports
 * as not-found — to this server a URI it does not serve is simply not a
 * resource.
 */
export function resolveResourceUri(
	vaultRoot: string,
	policy: ExposurePolicy,
	uri: string,
): string | null {
	const m = String(uri).match(/^vault:\/\/note\/(.+)$/);
	if (!m?.[1]) return null;

	let rel: string;
	try {
		rel = m[1]
			.split("/")
			.map((s) => decodeURIComponent(s))
			.join("/");
	} catch {
		return null;
	}

	// Traversal and absolute paths are refused before touching the filesystem.
	if (rel.includes("..") || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return null;
	if (!rel.toLowerCase().endsWith(".md")) return null;
	if (!isExposedPath(policy, rel)) return null;
	if (policy.neverExpose.has(basename(rel))) return null;

	// Containment must survive SYMLINKS, not just `..`. `resolve` collapses dot
	// segments but happily returns a path whose real target is outside the vault,
	// so a symlink inside an exposed folder would read anything this process can
	// read. Both ends are resolved through `realpath` and compared.
	//
	// Against the DECLARED root, not the first path segment: roots are prefixes,
	// so a vault serving `work/active/` and not `work/1-1/` must not accept a link
	// under the former resolving into the latter — both share the segment `work`.
	const root = matchedRoot(policy, rel);
	if (!root) return null;
	let rootReal: string;
	let full: string;
	try {
		rootReal = realpathSync(resolve(join(vaultRoot, root)));
		full = realpathSync(resolve(join(vaultRoot, rel)));
	} catch {
		return null; // missing, or a broken link
	}
	if (full !== rootReal && !full.startsWith(rootReal + sep)) return null;
	if (policy.neverExpose.has(basename(full))) return null;
	if (isPrivate(full)) return null;
	return full;
}
