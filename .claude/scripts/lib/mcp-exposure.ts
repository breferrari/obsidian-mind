/**
 * The fence: which notes may leave the vault, on any surface.
 *
 * WHAT IS BEING DEFENDED
 *
 * Not secrecy from the user — same machine, same account, `cat` works. The risk
 * is EGRESS: a session pasting vault material into a commit message, a PR body
 * or an issue on a public repo. That is a real failure shape here, not a
 * hypothetical one.
 *
 * So the fence is drawn by SENSITIVITY, not by project. An earlier revision
 * scoped notes to the calling repo and it cost the single best capability
 * measured in the whole spike: the answer that justified an expensive tier-3
 * call did so by connecting one project's constraint to another project's open
 * issue. Cross-project reading is the product. Folder sensitivity is the fence.
 *
 * THREE LAYERS, ALL OF THEM REQUIRED
 *
 *   1. the note's top-level folder is in the exposed set
 *   2. its filename is not in the never-expose list
 *   3. it is not tagged `private` in frontmatter
 *
 * EVERY surface must apply all three. This module exists so there is one
 * implementation to apply, because the recurring defect in this layer is a
 * second read path that quietly skips the check — search proxied the whole
 * index while resources were scoped, and separately the resource enumerators
 * read `brain/` and `projects/` directly, ignoring the exposed-root list they
 * were supposed to obey. Both were the same mistake twice.
 */

import { readFileSync, readdirSync, statSync, existsSync, realpathSync } from "node:fs";
import { join, basename, resolve, sep } from "node:path";

import { discoverExposedRoots } from "./memory-discover.ts";
import { vaultRelKey } from "./mcp-qmd-client.ts";

/** How deep to walk inside an exposed root. */
const MAX_DEPTH = 4;
/** How much of a file to read when probing its frontmatter. */
const HEAD_BYTES = 1200;

export interface ExposurePolicy {
	/** Top-level folders whose notes may be read. */
	readonly roots: readonly string[];
	/** Filenames withheld regardless of folder. */
	readonly neverExpose: ReadonlySet<string>;
	/** Where the root list came from, for `health` to report. */
	readonly source: "manifest" | "derived" | "fallback";
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

/**
 * A deliberately NARROW default.
 *
 * The prototype defaulted to one specific vault's four folders. A vault that has
 * thought about exposure declares it; a vault that has not should not be
 * surprised by what its coding sessions can read. Widening is a decision someone
 * makes on purpose.
 */
const DEFAULT_EXPOSED_ROOTS: readonly string[] = ["brain", "reference"];

/** Roots are plain folder names — anything that could climb out is refused. */
function cleanRoots(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((s): s is string => typeof s === "string" && /^[\w.-]+$/.test(s) && s !== "..");
}

/**
 * Resolve the exposure policy for a vault.
 *
 * Precedence: an explicit `mcp_exposed_roots` declaration, then the manifest's
 * `user_content_roots` (which the template already maintains for other reasons,
 * so there is no second list to keep correct), then the narrow default.
 */
export function resolveExposure(vaultRoot: string, manifest: Record<string, unknown> | null | undefined): ExposurePolicy {
	// `mcp_never_expose` holds FILENAMES, which legitimately contain spaces and
	// dots, so the root-name rule is too strict for it. Taken as declared.
	const never = new Set(
		Array.isArray(manifest?.mcp_never_expose)
			? manifest.mcp_never_expose.filter((s): s is string => typeof s === "string")
			: [],
	);

	const declared = cleanRoots(manifest?.mcp_exposed_roots);
	if (declared.length) return { roots: declared, neverExpose: never, source: "manifest" };

	try {
		const found = discoverExposedRoots(vaultRoot, manifest ?? {}, [...DEFAULT_EXPOSED_ROOTS]);
		return {
			roots: found.roots,
			neverExpose: never,
			source: found.source === "manifest" ? "derived" : "fallback",
		};
	} catch {
		return { roots: [...DEFAULT_EXPOSED_ROOTS], neverExpose: never, source: "fallback" };
	}
}

/**
 * Is this note marked private?
 *
 * An UNREADABLE file returns true. Withholding something we cannot inspect is
 * the only safe default: the alternative is that a permissions error becomes an
 * exposure.
 */
export function isPrivate(path: string): boolean {
	try {
		const head = readFileSync(path, "utf8").slice(0, HEAD_BYTES);
		return /^\s*-?\s*private\s*$/m.test(head) || /^private:\s*true/m.test(head);
	} catch {
		return true;
	}
}

/** Pull the frontmatter `description:` so a resource list is self-describing. */
export function firstDescription(path: string, fallback = "Vault note"): string {
	try {
		const head = readFileSync(path, "utf8").slice(0, HEAD_BYTES);
		const m = head.match(/^description:\s*"?(.+?)"?\s*$/m);
		return m?.[1] ? m[1].slice(0, 200) : fallback;
	} catch {
		return fallback;
	}
}

/** Is `rel` inside one of the policy's exposed roots? */
export function isExposedPath(policy: ExposurePolicy, relPath: string): boolean {
	const first = relPath.replace(/\\/g, "/").split("/")[0];
	if (!first) return false;
	return policy.roots.some((r) => r.toLowerCase() === first.toLowerCase());
}

/**
 * Every note this vault will expose, on any surface.
 *
 * This is the single source of truth. `search` filters its hits against it,
 * `expand` computes backlinks only over it, and the resource enumerators build
 * from it — so a note cannot be invisible on one surface and readable on
 * another, which is exactly the defect that produced the confidential-note leak.
 */
export function visibleFiles(vaultRoot: string, policy: ExposurePolicy): VisibleFile[] {
	const files: VisibleFile[] = [];

	const walk = (dir: string, scope: string, depth: number): void => {
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
			let isDir = false;
			try {
				isDir = statSync(full).isDirectory();
			} catch {
				continue;
			}
			if (isDir) {
				walk(full, scope, depth + 1);
				continue;
			}
			if (!f.endsWith(".md")) continue;
			if (policy.neverExpose.has(f)) continue;
			if (isPrivate(full)) continue;
			files.push({ full, label: basename(f, ".md"), scope });
		}
	};

	for (const root of policy.roots) walk(join(vaultRoot, root), root, 0);
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
 * Built from `visibleFiles`, which is the fix for a real defect: the prototype's
 * enumerators read `brain/` and `projects/` from disk directly, so a vault that
 * declared `mcp_exposed_roots` WITHOUT those folders still handed them out. The
 * fence was configured and ignored.
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
 * Resolve a `vault://note/<rel>` URI back to a file, enforcing the fence again.
 *
 * Re-checked rather than trusted: a URI is caller-supplied input, and the fact
 * that this server minted one earlier is not evidence that THIS one is legal.
 * Returns null for anything outside the policy, which the caller reports as
 * not-found rather than as forbidden — the existence of a withheld note is
 * itself something the fence is hiding.
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
	// so a symlink planted inside an exposed folder would read anything this
	// process can read. MCPVault shipped exactly this bug and patched it in
	// v0.9.1 — a real project already paid for the lesson.
	const segment = rel.replace(/\\/g, "/").split("/")[0] ?? "";
	let rootReal: string;
	let full: string;
	try {
		rootReal = realpathSync(resolve(join(vaultRoot, segment)));
		full = realpathSync(resolve(join(vaultRoot, rel)));
	} catch {
		return null; // missing, or a broken link
	}
	if (full !== rootReal && !full.startsWith(rootReal + sep)) return null;
	if (policy.neverExpose.has(basename(full))) return null;
	if (isPrivate(full)) return null;
	return full;
}
