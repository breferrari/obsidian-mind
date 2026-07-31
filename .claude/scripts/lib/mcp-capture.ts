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
 * folder must resolve inside an exposed root, so a destination string cannot
 * turn this tool into an arbitrary write anywhere on disk.
 */

import { existsSync, readdirSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { type ExposurePolicy, isExposedPath, matchedRoot } from "./mcp-exposure.ts";
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
 * A YAML **single**-quoted scalar, which is the only quoting a caller-supplied
 * string can survive.
 *
 * The double-quoted form looks equivalent and is not, because it processes
 * escapes. A title carrying a Windows path — `C:\temp\x`, which this repo's own
 * fixtures deliberately contain — becomes `"C:\temp\x"`, where `\t` is a TAB
 * and `\x` demands two hex digits. That is a parse error, and it takes the
 * whole frontmatter block with it rather than just the one field. Swapping `"`
 * for `'` inside a double-quoted scalar, which is what this file used to do,
 * defends against exactly one of the characters that matter.
 *
 * In the single-quoted form the only escape is `''` for a literal quote, and a
 * backslash is a backslash. Whitespace is flattened here rather than at the
 * call sites, because a newline is the other way a scalar ends early: the
 * continuation line lands at column zero, under-indented for the block it is
 * inside, and the document is broken from there down.
 *
 * Flattening at the boundary is deliberate — every field this wraps is
 * single-line by contract, so there is no case where a caller wants the raw
 * newline preserved and a helper that guaranteed it only sometimes would be
 * worth less than one that always does.
 */
export function yamlQuoted(text: unknown): string {
	const flat = String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return `'${flat.replace(/'/g, "''")}'`;
}

/**
 * A description that stops at a word, not mid-syllable.
 *
 * The naive `slice(0, MAX)` cuts wherever the budget runs out, and the result is
 * indistinguishable from a complete sentence that happened to end there. That
 * field is the single most load-bearing line a note has in a vault whose
 * `MEMORY.md` is generated from it: it is what a future session reads before
 * deciding whether to open the note at all. A reader who cannot tell an
 * amputated description from a whole one has to open every note to find out,
 * which is the cost the index exists to remove.
 *
 * So: break on whitespace and mark it. The ellipsis is the whole point — it
 * makes truncation *visible*, which is what the hard cut never was.
 *
 * The 60% floor covers the degenerate case of a budget containing no whitespace
 * at all (one long token, or a script that does not space between words), where
 * breaking at the last space would throw away most of the allowance. There, a
 * hard cut with an ellipsis is still better than a hard cut without one.
 */
export function clampDescription(text: unknown, max: number = DESCRIPTION_MAX): string {
	const flat = String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
	if (flat.length <= max) return flat;
	const cut = flat.slice(0, max - 1);
	const lastSpace = cut.lastIndexOf(" ");
	const stem = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
	return `${stem.replace(/[\s,;:.–—-]+$/, "")}…`;
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
		// `isExposedPath` rather than a first-segment match, because roots are
		// path PREFIXES. The old form compared `rel.split("/")[0]` against the
		// root list, so a vault declaring `work/active` — which is the shape
		// almost every root in the shipped manifest has — refused
		// `folder: "work/active"` with the message *"'work' is not an exposed
		// root (allowed: brain, work/active)"*, naming the root it had just
		// refused. On a default install that is every root a user would file
		// into, and the `inbox/` fallback hid it as a routing quirk.
		if (!isExposedPath(policy, rel)) {
			throw new Error(`refused: "${rel}" is not inside an exposed root (allowed: ${policy.roots.join(", ")})`);
		}
		// No traversal segments at all. Checking containment against the VAULT is
		// not enough: `brain/../work` passes the root check on its first segment
		// and still resolves inside the vault, so it landed in `work/` — a folder
		// the caller never named and the policy may not even serve.
		if (rel.split(/[\\/]/).some((seg) => seg === "..")) {
			throw new Error(`refused: "${folder}" contains a traversal segment`);
		}
		const dir = resolve(join(vaultRoot, rel));
		// Containment against the MATCHED declared root, not merely the vault and
		// not the first path segment: roots are prefixes, so a vault serving
		// `work/active/` and not `work/1-1/` must be contained against the former.
		const root = matchedRoot(policy, rel) ?? "";
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

/**
 * Tool-call framing that a serialization failure can spill into a field value.
 *
 * Observed for real: a `record_work` call arrived whose `summary` ended with a
 * closing tag followed by the entire `changes` array as literal text. The server
 * accepted it verbatim, so the note carried raw markup, the changes section never
 * rendered at all, and the corruption was only noticed because a human saw the
 * tags rendering in Obsidian days later. Every automated signal said success: the
 * call returned, the file was written, every field was a non-empty string.
 *
 * Deliberately narrow. `</summary>` alone is NOT matched, because
 * `<details><summary>` is legitimate prose and notes routinely fold superseded
 * plans with it. The three forms below never occur in real writing, so a match is
 * a structural failure rather than a judgement call. That is why the caller is
 * refused rather than warned: a field that has swallowed the next field cannot be
 * repaired by guessing where it ended.
 */
const TOOL_MARKUP = /<parameter\s+name=|<\/?(?:antml:)?invoke\b|<\/?(?:antml:)?function_calls\b/i;

/** The fields a malformed call can corrupt, named so the error can say which. */
export function findToolMarkup(input: Record<string, unknown>): string | null {
	for (const [key, value] of Object.entries(input)) {
		const texts = Array.isArray(value) ? value.map((v) => String(v)) : [String(value ?? "")];
		if (texts.some((t) => TOOL_MARKUP.test(t))) return key;
	}
	return null;
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
	const title = String(input.title ?? "").trim();

	// The title, carried as an alias, is what makes this note reachable by the
	// name it calls itself.
	//
	// The filename is a slug of the title: lowercased, punctuation stripped,
	// whitespace hyphenated, cut at SLUG_MAX, and prefixed with the date. So the
	// basename is NEVER the title — not only when it was truncated. `[[I3 lands:
	// a soak]]` cannot resolve to `2026-07-31-i3-lands-a-soak.md`, because
	// `resolvableNames` matches on basenames and aliases and this note had
	// neither spelling of its own name.
	//
	// The consequence was that every cross-reference this renderer emits between
	// its own notes fell to `_(no note yet)_`, including references to notes
	// written hours earlier, so a run of captures arrived mutually unlinked —
	// orphans, in a vault whose stated rule is that a note without links is a
	// bug. The links were always *intended*; the resolver simply could not see
	// the target.
	//
	// Fixing it here rather than by keeping full-length filenames is deliberate:
	// filenames are already published and linked, a longer one still would not
	// round-trip through slugification, and `resolvableNames` has read aliases
	// since it was written — for exactly this class of problem, where a note's
	// real name and its file's name differ.
	const aliases = title ? ["aliases:", `  - ${yamlQuoted(title)}`] : [];

	return [
		"---",
		`date: ${day}`,
		`description: ${yamlQuoted(clampDescription(summary))}`,
		...aliases,
		"tags:",
		input.kind === "decision" ? "  - decision" : "  - project-note",
		...(dest.project ? [`project: ${dest.project}`] : []),
		`source_repo: ${caller}`,
		"---",
		"",
		`# ${title}`,
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
