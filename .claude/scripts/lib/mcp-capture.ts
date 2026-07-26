/**
 * `record_work` — filing what happened in a repo back into the vault.
 *
 * The sibling of `remember`, and constantly confused with it. The distinction
 * is single-valued vs multi-valued: a WORK RECORD is about one project at one
 * moment, so it has a correct folder and gets filed into it. A MEMORY may touch
 * several projects and a cross-cutting theme, so it has no correct folder and
 * lives under a date with its reach declared in frontmatter.
 *
 * ROUTING IS DELEGATED, NOT INFERRED
 *
 * The calling session already carries the vault's conventions (through the
 * injected contract) and can search the vault to see where similar notes live.
 * It is an agent the user is already paying for, so asking it to choose costs
 * nothing extra and beats anything this server could infer from a repo name.
 *
 * The server's job is therefore to VALIDATE, never to guess: a caller-supplied
 * folder must resolve inside an exposed root, so a session cannot talk the
 * server into writing to a fenced folder.
 */

import { existsSync, readdirSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import type { ExposurePolicy } from "./mcp-exposure.ts";
import { claimFile } from "./atomic-write.ts";

const SLUG_MAX = 60;
const MAX_COLLISIONS = 500;
const DESCRIPTION_MAX = 150;

export interface Destination {
	readonly dir: string;
	readonly rel: string;
	readonly project: string | null;
	readonly routed: "caller" | "caller-identity" | "fallback";
}

export interface CaptureInput {
	readonly title?: unknown;
	readonly summary?: unknown;
	readonly changes?: unknown;
	readonly decisions?: unknown;
	readonly learned?: unknown;
	readonly verification?: unknown;
	readonly open?: unknown;
	readonly informed_by?: unknown;
	readonly folder?: unknown;
	readonly kind?: unknown;
	readonly dry_run?: unknown;
}

export interface CaptureResult {
	readonly path: string;
	readonly bytes: number;
	readonly written: boolean;
	readonly routed: Destination["routed"];
	readonly preview?: string;
	readonly indexed?: boolean;
}

/** Filesystem-safe stem from a title. Separators are stripped, not escaped. */
export function slugifyTitle(title: unknown): string {
	return String(title)
		.normalize("NFKD")
		.replace(/[^\w\s-]/g, "")
		.trim()
		.replace(/\s+/g, "-")
		.slice(0, SLUG_MAX)
		.replace(/^-+|-+$/g, "")
		.toLowerCase();
}

/**
 * The project folder matching a calling repo, if this vault has one.
 *
 * Exact match, then case-insensitive, then a prefix match in either direction —
 * a repo and its project folder usually agree but not always ("poc" vs
 * "pocket"). Returns null when the vault has no `projects/` folder at all,
 * which a clean install of this template does not.
 */
export function projectDirFor(vaultRoot: string, caller: string | null): { name: string; dir: string } | null {
	if (!caller) return null;
	const root = join(vaultRoot, "projects");
	if (!existsSync(root)) return null;

	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return null;
	}
	// Matched against the directory listing rather than with existsSync, so the
	// name returned is the folder's REAL casing. On a case-insensitive
	// filesystem existsSync(join(root, "Pocket")) succeeds for a folder actually
	// called "pocket", and the caller's casing would then be written into every
	// capture's `project:` frontmatter — splitting one project into two groups in
	// any Base that filters on it.
	const want = caller.toLowerCase();
	const hit =
		entries.find((e) => e === caller) ??
		entries.find((e) => e.toLowerCase() === want) ??
		entries.find((e) => {
			const a = e.toLowerCase();
			return a.startsWith(want) || want.startsWith(a);
		});
	return hit ? { name: hit, dir: join(root, hit) } : null;
}

/**
 * Where the note goes, cheapest-and-most-informed first:
 *
 *  1. a `folder` the caller chose — validated, never trusted
 *  2. derived from caller identity, when the repo maps to a project folder
 *  3. the configured inbox, for the genuinely unknown case only
 */
export function resolveDestination(
	vaultRoot: string,
	policy: ExposurePolicy,
	manifest: Record<string, unknown> | null | undefined,
	caller: string | null,
	folder: unknown,
	kind: unknown,
): Destination {
	if (typeof folder === "string" && folder.trim()) {
		const rel = folder.trim().replace(/^[\\/]+|[\\/]+$/g, "");
		const root = rel.split(/[\\/]/)[0] ?? "";
		if (!policy.roots.some((r) => r.toLowerCase() === root.toLowerCase())) {
			throw new Error(`refused: "${root}" is not an exposed root (allowed: ${policy.roots.join(", ")})`);
		}
		// No traversal segments at all. Checking containment against the VAULT is
		// not enough: `brain/../work` passes the root check on its first segment
		// and resolves to a path still inside the vault, so an earlier version
		// wrote into the fenced `work/` folder. Verified doing exactly that.
		if (rel.split(/[\\/]/).some((seg) => seg === "..")) {
			throw new Error(`refused: "${folder}" contains a traversal segment`);
		}
		const dir = resolve(join(vaultRoot, rel));
		// Containment against the DECLARED ROOT, not merely the vault — the fence
		// is per-folder, so "inside the vault" is the wrong question.
		const rootDir = resolve(join(vaultRoot, root));
		if (dir !== rootDir && !dir.startsWith(rootDir + sep)) {
			throw new Error(`refused: "${folder}" escapes the "${root}" root`);
		}
		return { dir, rel, project: null, routed: "caller" };
	}

	const proj = projectDirFor(vaultRoot, caller);
	if (proj) {
		const sub = kind === "decision" ? "decisions" : "notes";
		return {
			dir: join(proj.dir, sub),
			rel: `projects/${proj.name}/${sub}`,
			project: proj.name,
			routed: "caller-identity",
		};
	}

	const declared = manifest?.mcp_inbox;
	const fallback = typeof declared === "string" && /^[\w.-]+$/.test(declared) ? declared : "inbox";
	return { dir: join(vaultRoot, fallback), rel: fallback, project: null, routed: "fallback" };
}

/** Render the note body. Pure, so the shape can be asserted without writing. */
export function renderCapture(
	input: CaptureInput,
	dest: Destination,
	caller: string,
	resolvable: ReadonlySet<string>,
	now: Date,
): string {
	const day = now.toISOString().slice(0, 10);

	const list = (arr: unknown): string | null =>
		Array.isArray(arr) && arr.length ? arr.map((x) => `- ${String(x).trim()}`).join("\n") : null;

	const section = (heading: string, content: string | null): string =>
		content ? `\n## ${heading}\n\n${content}\n` : "";

	// Only emit links that actually resolve. A capture that manufactures broken
	// links is worse than one that omits them: it degrades the graph silently and
	// trips the vault's own wikilink gate.
	const linkOrPlain = (raw: unknown): string => {
		const name = String(raw).replace(/^\[\[|\]\]$/g, "").trim();
		return resolvable.has(name.toLowerCase()) ? `- [[${name}]]` : `- ${name} _(no note yet)_`;
	};

	// `informed_by` becomes wikilinks, which is the point of asking for it: the
	// notes that shaped this work gain a backlink proving they were applied. A
	// decision with no backlinks is either unused or undiscoverable, and this is
	// how you tell the difference.
	const informed =
		Array.isArray(input.informed_by) && input.informed_by.length
			? input.informed_by.map(linkOrPlain).join("\n")
			: null;

	// Orphans are bugs, but so are broken links. Link home only if the project is
	// genuinely reachable by name (a README alias, usually).
	const home = dest.project && resolvable.has(dest.project.toLowerCase()) ? `- [[${dest.project}]]` : null;
	const related = [home, informed].filter(Boolean).join("\n");

	const summary = String(input.summary ?? "").trim();

	return [
		"---",
		`date: ${day}`,
		`description: "${summary.replace(/"/g, "'").replace(/\s+/g, " ").slice(0, DESCRIPTION_MAX)}"`,
		"tags:",
		input.kind === "decision" ? "  - decision" : "  - project-note",
		...(dest.project ? [`project: ${dest.project}`] : []),
		`source_repo: ${caller}`,
		"---",
		"",
		`# ${String(input.title ?? "").trim()}`,
		"",
		summary,
		section("What changed", list(input.changes)),
		section("Decisions", list(input.decisions)),
		section("Learned", list(input.learned)),
		section("Verification", input.verification ? String(input.verification).trim() : null),
		section("Open", list(input.open)),
		section("Related", related || null),
		"",
		`_Recorded ${now.toISOString()} from \`${caller}\` via the om MCP server (routing: ${dest.routed})._`,
		"",
	].join("\n");
}

/**
 * File the note.
 *
 * Written to a temp file first, so a crash mid-write cannot leave a half-note
 * for the indexer to pick up, then the final name is claimed with an ATOMIC
 * exclusive create.
 *
 * The obvious version — `while (existsSync(x)) bump(x); rename(tmp, x)` — is a
 * TOCTOU race: two processes can both see a name free, and `rename` silently
 * OVERWRITES, so one capture vanishes with no error. It did not reproduce
 * across 8 concurrent writers because process startup staggers them, but "did
 * not fire" is not "cannot fire". `COPYFILE_EXCL` fails instead of clobbering,
 * so the loser simply takes the next suffix.
 */
export function captureNote(
	vaultRoot: string,
	policy: ExposurePolicy,
	manifest: Record<string, unknown> | null | undefined,
	caller: string | null,
	input: CaptureInput,
	resolvable: ReadonlySet<string>,
	opts: { now?: Date; reindex?: () => boolean } = {},
): CaptureResult {
	const now = opts.now ?? new Date();
	const who = caller ?? "unknown";

	const stemBase = slugifyTitle(input.title);
	if (!stemBase) throw new Error("title produces an empty filename");

	const dest = resolveDestination(vaultRoot, policy, manifest, caller, input.folder, input.kind);

	// A capture is a RECORD OF WHAT HAPPENED — point-in-time, so it takes the
	// vault's `YYYY-MM-DD ` naming law. A decision is a living document and does
	// not, because a creation-date prefix inverts the recency signal on a note
	// that keeps being edited.
	const day = now.toISOString().slice(0, 10);
	const stem = input.kind === "decision" ? stemBase : `${day}-${stemBase}`;

	const body = renderCapture(input, dest, who, resolvable, now);

	// Returned BEFORE the destination is created. An earlier version made the
	// folder first, so previewing a capture left an empty `inbox/` in the user's
	// vault — a "dry run" that changes the vault is not one, and the whole point
	// of the preview is that it can be trusted.
	if (input.dry_run === true) {
		return {
			path: `${dest.rel}/${stem}.md`,
			bytes: body.length,
			written: false,
			routed: dest.routed,
			preview: body.slice(0, 600),
		};
	}

	if (!existsSync(dest.dir)) mkdirSync(dest.dir, { recursive: true });
	const base = realpathSync(dest.dir);

	// Claimed atomically rather than checked-then-written; see `atomic-write.ts`
	// for why, and for what the naive version cost.
	const claimed = claimFile(base, body, (n) => (n === 1 ? `${stem}.md` : `${stem}-${n}.md`), {
		maxAttempts: MAX_COLLISIONS,
		// Containment: slugify strips separators, but verify rather than trust.
		verify: (full) => {
			if (!resolve(full).startsWith(base + sep)) throw new Error("refused: path escapes the destination");
		},
		exhaustedMessage: "too many colliding captures for that title",
	});

	// Index it NOW. An MCP write bypasses the PostToolUse hook that normally
	// triggers re-indexing, so without this the note is on disk but invisible to
	// search — written and unfindable.
	const indexed = opts.reindex ? opts.reindex() : undefined;
	return {
		path: `${dest.rel}/${claimed.name}`,
		bytes: body.length,
		written: true,
		routed: dest.routed,
		...(indexed === undefined ? {} : { indexed }),
	};
}
