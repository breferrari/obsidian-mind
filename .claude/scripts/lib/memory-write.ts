/**
 * The vault memory layer — write path.
 *
 * Pure functions over plain data, plus one thin IO shell (`writeMemory`), so the
 * epistemic contract can be hammered by tests without an MCP client, a vault on
 * disk, or a search index.
 *
 * WHY THIS IS SEPARATE FROM A WORK RECORD
 *
 * A *work record* ("what I did in this repo today") is single-valued by nature:
 * it belongs to the project it happened in, and it is a log entry. A *memory*
 * ("a tsup-external dependency can't be fixed by a local patch") is multi-valued
 * by nature: it transfers, and its whole worth is that a session in a DIFFERENT
 * repo can find it. One tool for both would force a single shape on two
 * artifacts and lose the facets that make the second findable.
 *
 * The routing test, stated for the model in the tool description: *would this
 * help someone working in a different repo?*
 */

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { claimFile } from "./atomic-write.ts";

/** Vault-relative root for every memory. Writes are confined to this prefix. */
export const MEMORY_ROOT = "memories";

/**
 * The `source` value that marks a file as agent-written.
 *
 * Here rather than beside the readers because this module is the one that
 * STAMPS it, and it already owns the store's on-disk contract. A reader can
 * import a constant the writer defines; the reverse would invert the dependency.
 */
export const MEMORY_SOURCE = "mcp-capture";

export const SCOPES = ["general", "platform", "project"] as const;
export const CONFIDENCE = ["verified", "inferred", "unverified"] as const;

export type Scope = (typeof SCOPES)[number];
export type Confidence = (typeof CONFIDENCE)[number];

/** Filenames truncate here; long titles are still fine as the H1. */
const SLUG_MAX = 60;

/** A memory shorter than this is not a memory, it is a shrug. */
const MIN_BODY = 40;

/**
 * Windows refuses these as filename stems, with or without an extension. A vault
 * syncing across machines gets a corrupt file rather than an error, so they are
 * rewritten rather than rejected.
 */
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

export interface MemoryInput {
	readonly title?: unknown;
	readonly body?: unknown;
	readonly confidence?: unknown;
	readonly verification?: unknown;
	readonly scope?: unknown;
	readonly generality?: unknown;
	readonly projects?: unknown;
	readonly platforms?: unknown;
}

export interface MemoryValue {
	readonly title: string;
	readonly body: string;
	readonly confidence: Confidence;
	readonly claimed_confidence: Confidence | null;
	readonly flags: string[];
	readonly verification: string | null;
	readonly generality: string | null;
	readonly scope: Scope;
	readonly projects: string[];
	readonly platforms: string[];
	readonly downgraded_from: Scope | null;
	readonly origin: string | null;
	readonly date: Date;
}

export interface ValidationResult {
	readonly ok: boolean;
	readonly errors: string[];
	readonly warnings: string[];
	readonly value: MemoryValue | null;
}

// ---------------------------------------------------------------------------
// Slug and path
// ---------------------------------------------------------------------------

/**
 * Filename-safe slug. Deliberately strict: the result is concatenated into a
 * path, so anything that could traverse (`..`), escape (`/`, `\`) or break a
 * filesystem (control chars, trailing dots) must not survive.
 */
export function slugify(title: unknown): string {
	let out = String(title ?? "")
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[<>:"|?*\u0000-\u001f]/g, " ")
		.replace(/[/\\]/g, " ")
		// Square brackets go too. A title carrying `[[Something]]` otherwise
		// produces a file literally named `... [[Something]].md`, which reads as a
		// wikilink embedded in a filename and confuses every surface showing it.
		.replace(/[[\]]/g, " ")
		.replace(/\.{2,}/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	if (out.length > SLUG_MAX) {
		out = out.slice(0, SLUG_MAX);
		const lastSpace = out.lastIndexOf(" ");
		if (lastSpace > SLUG_MAX * 0.6) out = out.slice(0, lastSpace);
		out = out.trim();
	}

	// NTFS silently strips trailing dots and spaces, producing a different file
	// than the one planned — fold them so path and reality agree.
	out = out.replace(/[. ]+$/, "");
	if (WINDOWS_RESERVED.test(out)) out = `_${out}`;
	return out;
}

/** `2026-07-26` from a Date, in the vault's local-date convention. */
export function isoDate(d: Date): string {
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * `memories/2026/07/2026-07-26 <slug>.md`
 *
 * Time is the ONLY thing in the path, because time is the only single-valued
 * fact about a memory. Two levels keeps any folder to a month's worth and the
 * tree at depth 3 — inside Obsidian's guidance, and matching the daily-note
 * convention users already recognise.
 */
export function memoryPath(date: Date, title: unknown, root: string = MEMORY_ROOT): string {
	const iso = isoDate(date);
	const [y, m] = iso.split("-");
	return `${root}/${y}/${m}/${iso} ${slugify(title)}.md`;
}

// ---------------------------------------------------------------------------
// Scope narrowing
// ---------------------------------------------------------------------------

/**
 * The caller proposes a scope; the server narrows it. Never widens.
 *
 * `general` is the only claim worth policing: widest blast radius, and the
 * cheapest thing for a session to over-claim. Because `projects` is a LIST, a
 * caller with a genuinely cross-project lesson can name them all honestly — so
 * an unjustified `general` is the one remaining way to over-reach, and the
 * origin repo is the evidence against it.
 *
 * The original claim is preserved: a downgrade that hides what was asked for is
 * a downgrade nobody can audit.
 */
export function narrowScope(input: {
	scope?: unknown;
	projects?: unknown;
	origin?: string | null;
}): { scope: Scope; projects: string[]; downgraded_from: Scope | null } {
	const claimed: Scope = (SCOPES as readonly string[]).includes(String(input.scope))
		? (input.scope as Scope)
		: "project";
	const named = Array.isArray(input.projects) ? (input.projects as unknown[]).filter(Boolean).map(String) : [];
	const origin = input.origin ?? null;

	// `general` is honest only when the memory names no project. If the caller
	// named projects, it is scoped to them by its own admission.
	if (claimed === "general" && named.length > 0) {
		return { scope: "project", projects: named, downgraded_from: "general" };
	}
	// `general` naming nothing STANDS.
	//
	// An earlier revision narrowed this to the origin repo, reasoning that one
	// session should not speak for the whole vault. The effect was that `general`
	// became UNREACHABLE through the server — every caller has an origin, so
	// every general memory silently became project-scoped to whoever wrote it.
	// The tier stayed in the reader, the tool schema, the Base view and the docs,
	// and nothing could ever produce it.
	//
	// It also contradicted the rule immediately above: general is honest exactly
	// WHEN no project is named, and this narrowed precisely that case. Declared
	// reach is the design; silently overriding an explicit declaration is not a
	// narrowing, it is a different memory. Over-claiming is answered by the
	// contract's warnings and by `origin` being recorded as evidence, not by
	// rewriting what the caller said.
	if (claimed === "project" && named.length === 0 && origin) {
		return { scope: "project", projects: [origin], downgraded_from: null };
	}
	return { scope: claimed, projects: named, downgraded_from: null };
}

// ---------------------------------------------------------------------------
// Link resolution
// ---------------------------------------------------------------------------

/**
 * Neutralise wikilinks in free text that point at notes which do not exist.
 *
 * `resolveLinks` below governs the `links:` ARRAY. This governs the BODY, and it
 * is needed for the same reason with a sharper consequence: a broken wikilink
 * anywhere in a note trips the vault's own wikilink gate, so an agent writing
 * `[[Some Note]]` from another repo can turn the user's test suite red in a
 * repository it has never seen.
 *
 * Neutralised rather than refused, and reported rather than silent. The text
 * survives as plain words — `[[Ghost]]` becomes `Ghost`, `[[Ghost|shown]]`
 * becomes `shown` — so the meaning is kept while the dangling edge is not
 * created. Refusing the whole write would throw away a good memory over a
 * formatting detail; writing it unchanged degrades the graph silently.
 */
export function neutralizeWikilinks(
	text: unknown,
	resolvableSet: ReadonlySet<string>,
): { text: string; dropped: string[] } {
	const dropped: string[] = [];
	const out = String(text ?? "").replace(
		/\[\[([^\]|#]+)((?:[#|][^\]]*)?)\]\]/g,
		(whole, rawTarget: string, suffix: string) => {
			const target = rawTarget.trim();
			if (resolvableSet.has(target.toLowerCase())) return whole;
			if (!dropped.includes(target)) dropped.push(target);
			// Prefer the alias, which is what a human was meant to read.
			const alias = suffix.startsWith("|") ? suffix.slice(1).trim() : "";
			return alias || target;
		},
	);
	return { text: out, dropped };
}

/**
 * Resolve proposed wikilink targets against names that actually exist.
 *
 * An MCP write bypasses the vault's own write-validation hook, so "never emit a
 * broken link" is re-implemented here. Unresolvable targets are dropped AND
 * reported — silently dropping would let a session believe it made a connection
 * it did not make.
 */
export function resolveLinks(
	proposed: unknown,
	resolvableSet: ReadonlySet<string>,
): { resolved: string[]; dropped: string[] } {
	const resolved: string[] = [];
	const dropped: string[] = [];
	const seen = new Set<string>();
	for (const raw of Array.isArray(proposed) ? proposed : []) {
		const name = String(raw ?? "").trim();
		if (!name) continue;
		const key = name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		if (resolvableSet.has(key)) resolved.push(name);
		else dropped.push(name);
	}
	return { resolved, dropped };
}

// ---------------------------------------------------------------------------
// The epistemic contract, as data
// ---------------------------------------------------------------------------

const HAPPENING =
	"break|breaks|broke|fail|fails|failed|crash|crashes|crashed|hang|hangs|error|errors|happen|happens|recover|recovers|work|works|worked";

// String.raw, NOT a plain template literal: in a template literal `\b` is the
// BACKSPACE character, so `new RegExp` would be handed a control char instead of
// a word boundary and the rule could never fire — silently. This bit once
// already, which is why every pattern here has a known-NEGATIVE test as well as
// a positive one.
const RECURRENCE = new RegExp(
	String.raw`\b(?:always|never)\b[^.!?]{0,40}\b(?:${HAPPENING})\b` +
		String.raw`|\bevery\s+time\b` +
		String.raw`|\bkeeps?\s+(?:on\s+)?(?:happening|breaking|failing|crashing)\b` +
		String.raw`|\brecurring\b` +
		String.raw`|\bconsistently\s+(?:${HAPPENING})\b`,
	"i",
);

const VOLATILE = /\b\d[\d,._]*\s*(stars?|forks?|downloads?|users?|subscribers?|followers?|commits?)\b/i;
const DATE_ANCHOR = /\bas of\b|\d{4}-\d{2}-\d{2}/i;
const SPEAKER = /^\s*(user|assistant|human|ai|system)\s*:/gim;

export interface ContractRule {
	readonly id: string;
	readonly severity: "reject" | "flag";
	readonly marker?: string;
	readonly test: (body: string) => boolean;
	readonly message: string;
}

/**
 * Rules as a list so a vault can extend, disable or reorder them without forking
 * the validator. Each declares its own severity, and that choice is the design:
 *
 *   reject — the artifact is structurally wrong. Nothing is written.
 *   flag   — the CLAIM is weak. The memory IS written, confidence is capped at
 *            `inferred`, and a marker lands in frontmatter for a review view.
 *
 * The first version rejected on prose judgements and immediately refused its own
 * canonical example: "the patch NEVER reaches them" is a deterministic
 * consequence, not a claim of recurrence. That is the argument against blocking
 * on prose — a false reject destroys knowledge the session already had, while a
 * false flag costs one line of frontmatter. Severity chosen accordingly, which
 * also means these patterns do not need to be perfect.
 */
export const CONTRACT_RULES: readonly ContractRule[] = [
	{
		id: "transcript",
		severity: "reject",
		// Structural, not a judgement: a transcript is a different artifact. The
		// threshold is high so a memory QUOTING one exchange is unaffected.
		test: (body) => (body.match(SPEAKER) ?? []).length >= 4,
		message:
			"body looks like a transcript. A memory is a conclusion, not a log — record what was learned, not the conversation that produced it.",
	},
	{
		id: "recurrence",
		severity: "flag",
		marker: "generalised",
		test: (body) => RECURRENCE.test(body),
		message:
			"body generalises over occurrences (always / every time / keeps failing). One session sees one occurrence, so confidence is capped at `inferred` — state the occurrence with its date and let the vault decide it is a pattern.",
	},
	{
		id: "undated-volatile",
		severity: "flag",
		marker: "volatile",
		test: (body) => VOLATILE.test(body) && !DATE_ANCHOR.test(body),
		message:
			'body states a figure that rots with no date anchor. Add "as of <date>" so staleness is visible instead of silent; the memory is flagged `volatile` until then.',
	},
];

/** Run the contract. Pure: returns verdicts, changes nothing. */
export function applyContract(
	body: string,
	rules: readonly ContractRule[] = CONTRACT_RULES,
): { rejections: string[]; flags: { id: string; marker: string; message: string }[] } {
	const rejections: string[] = [];
	const flags: { id: string; marker: string; message: string }[] = [];
	for (const rule of rules) {
		let hit = false;
		try {
			hit = Boolean(rule.test(body));
		} catch {
			// A broken custom rule must not take the whole write down.
			continue;
		}
		if (!hit) continue;
		if (rule.severity === "reject") rejections.push(rule.message);
		else flags.push({ id: rule.id, marker: rule.marker ?? rule.id, message: rule.message });
	}
	return { rejections, flags };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateMemory(
	input: MemoryInput | null | undefined,
	ctx: { now?: Date; origin?: string | null; rules?: readonly ContractRule[] } = {},
): ValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	const title = String(input?.title ?? "").trim();
	const body = String(input?.body ?? "").trim();
	const now = ctx.now instanceof Date ? ctx.now : new Date();

	if (!title) errors.push("title is required");
	else if (title.length > 200) errors.push("title is too long (max 200 chars)");
	else if (!slugify(title)) {
		errors.push(
			`title ${JSON.stringify(title)} contains no characters usable in a filename — give it a title with letters or digits`,
		);
	}

	if (!body) errors.push("body is required");
	else if (body.length < MIN_BODY) {
		errors.push(
			`body is ${body.length} chars; a memory needs at least ${MIN_BODY}. Write it for a session that will not have your context.`,
		);
	}

	const confidence = String(input?.confidence ?? "").trim();
	if (!(CONFIDENCE as readonly string[]).includes(confidence)) {
		errors.push(`confidence must be one of ${CONFIDENCE.join(" | ")}`);
	}

	if (input?.scope !== undefined && !(SCOPES as readonly string[]).includes(String(input.scope))) {
		errors.push(`scope must be one of ${SCOPES.join(" | ")}`);
	}

	for (const field of ["projects", "platforms"] as const) {
		const v = input?.[field];
		if (v === undefined || v === null) continue;
		if (!Array.isArray(v)) {
			errors.push(`${field} must be an array (it is the multi-valued axis)`);
			continue;
		}
		for (const item of v as unknown[]) {
			if (typeof item !== "string" || !/^[\w.-]+$/.test(item)) {
				errors.push(`${field} entries must be simple slugs; got ${JSON.stringify(item)}`);
			}
		}
	}

	const { rejections, flags } = applyContract(body, ctx.rules ?? CONTRACT_RULES);
	errors.push(...rejections);
	for (const f of flags) warnings.push(f.message);

	if (body.length > 8000) {
		warnings.push(`body is ${body.length} chars. Memories are atomic; consider splitting into separate lessons.`);
	}
	if (confidence === "verified" && !input?.verification) {
		warnings.push(
			'confidence is "verified" but no verification was given. Say how you know — otherwise "inferred" is the honest value.',
		);
	}

	if (errors.length) return { ok: false, errors, warnings, value: null };

	const narrowed = narrowScope({
		scope: input?.scope ?? "project",
		projects: input?.projects,
		origin: ctx.origin ?? null,
	});
	const platformsGiven = Array.isArray(input?.platforms)
		? (input.platforms as unknown[]).filter(Boolean).map(String)
		: [];

	// REFUSE A MEMORY THAT WOULD REACH NOBODY.
	//
	// A project-scoped memory naming no projects is invisible to every caller:
	// the visibility rule has nothing to match on. It would validate, write,
	// index and report success — and be unreachable forever. The hole is a caller
	// with neither identity nor named projects, i.e. a client that never answered
	// `roots/list`, which is an observed state rather than a theoretical one.
	//
	// Refusing beats widening to `general`: scope IS reach, and granting the
	// widest possible reach because the narrowest could not be determined is the
	// exact opposite of what narrowing exists to do.
	if (narrowed.scope === "project" && narrowed.projects.length === 0) {
		return {
			ok: false,
			errors: [
				'This memory would reach nobody: it is project-scoped, names no projects, and the caller has no identity (no MCP roots). Name the projects it applies to, or pass scope: "general" if it genuinely applies everywhere.',
			],
			warnings,
			value: null,
		};
	}
	if (narrowed.scope === "platform" && platformsGiven.length === 0) {
		return {
			ok: false,
			errors: [
				'This memory would reach nobody: it is platform-scoped but names no platforms. List them, or use scope: "project" with the projects it applies to.',
			],
			warnings,
			value: null,
		};
	}

	// OVER-CLAIMED REACH IS ANSWERED HERE, AND ONLY HERE.
	//
	// Sibling of the `verified`-without-`verification` warning above, and the same
	// severity on purpose. Narrowing `general` by inspecting content was tried and
	// reverted (see `narrowScope`): declared reach is the caller's to declare, and
	// over-claiming is answered by warnings and by `origin` as evidence, never by
	// rewriting what the caller said. This asks for the reasoning instead.
	//
	// Keyed on the NARROWED scope, not the claimed one. A caller who says
	// `general` and names projects has already been downgraded to `project` by
	// their own admission, and warning them about generality would be noise.
	if (narrowed.scope === "general" && !input?.generality) {
		warnings.push(
			'scope is "general" but no generality was given. Say why it reaches everywhere: a dependency, language or toolchain lesson is "platform", however hard-won.',
		);
	}

	const capped = flags.length && confidence === "verified";
	return {
		ok: true,
		errors,
		warnings,
		value: {
			title,
			body,
			// A flagged claim cannot stay `verified` regardless of what the caller
			// asserted: the flag exists precisely because the claim outruns what one
			// session can know. Capping is the enforcement; the marker is the audit.
			confidence: capped ? "inferred" : (confidence as Confidence),
			claimed_confidence: capped ? "verified" : null,
			flags: flags.map((f) => f.marker),
			verification: input?.verification ? String(input.verification).trim() : null,
			generality: input?.generality ? String(input.generality).trim() : null,
			scope: narrowed.scope,
			projects: narrowed.projects,
			platforms: platformsGiven,
			downgraded_from: narrowed.downgraded_from,
			origin: ctx.origin ?? null,
			date: now,
		},
	};
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** YAML-safe double-quoted scalar. Frontmatter that fails to parse is invisible. */
function yamlString(s: unknown): string {
	return JSON.stringify(String(s));
}

function yamlList(items: readonly string[]): string {
	return `[${items.map((i) => yamlString(i)).join(", ")}]`;
}

/**
 * ~150-char description, the vault-wide requirement. Derived from the body's
 * first sentence so it is always present without asking the caller for it.
 */
export function deriveDescription(body: string): string {
	const flat = body.replace(/\s+/g, " ").trim();
	const firstStop = flat.search(/[.!?]\s/);
	let out = firstStop > 40 ? flat.slice(0, firstStop + 1) : flat;
	if (out.length > 150) {
		out = out.slice(0, 150);
		const lastSpace = out.lastIndexOf(" ");
		if (lastSpace > 100) out = out.slice(0, lastSpace);
		out = `${out.trim()}…`;
	}
	return out;
}

export function renderMemory(value: MemoryValue, links: readonly string[] = []): string {
	const fm = [
		"---",
		`date: ${isoDate(value.date)}`,
		`description: ${yamlString(deriveDescription(value.body))}`,
		"tags: [memory]",
		`source: ${MEMORY_SOURCE}`,
		`origin: ${yamlString(value.origin ?? "unknown")}`,
		`session: ${yamlString(value.date.toISOString())}`,
		`scope: ${value.scope}`,
		`projects: ${yamlList(value.projects)}`,
	];
	if (value.platforms.length) fm.push(`platforms: ${yamlList(value.platforms)}`);
	fm.push(`confidence: ${value.confidence}`);
	if (value.claimed_confidence) fm.push(`claimed_confidence: ${value.claimed_confidence}`);
	// Markers make the contract operational: a Base can list every weak claim in
	// the vault without re-reading a single body.
	if (value.flags.length) fm.push(`flags: ${yamlList(value.flags)}`);
	if (value.downgraded_from) fm.push(`claimed_scope: ${value.downgraded_from}`);
	fm.push("---", "");

	const parts = [fm.join("\n"), `# ${value.title}`, "", value.body, ""];
	if (value.verification) parts.push("## How this is known", "", value.verification, "");
	// Rendered rather than kept in frontmatter: a reach claim is an argument, and a
	// later reader has to be able to judge it the same way they judge the evidence.
	if (value.generality) parts.push("## Why this reaches everywhere", "", value.generality, "");
	// A note without links is a bug — the vault's own doctrine. Links are the only
	// way a memory reaches the project it is about, since it does not live inside
	// that project's folder.
	if (links.length) parts.push("## Related", "", ...links.map((l) => `- [[${l}]]`), "");
	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// IO shell
// ---------------------------------------------------------------------------

/**
 * Write the memory. The only impure function here.
 *
 * Collision handling matters more than it looks: two memories captured the same
 * day with the same title would otherwise silently overwrite, and the loser is
 * unrecoverable. Suffix rather than clobber.
 */
export function writeMemory(
	vaultRoot: string,
	value: MemoryValue,
	links: readonly string[],
	{ root = MEMORY_ROOT }: { root?: string } = {},
): { rel: string; full: string } {
	const base = memoryPath(value.date, value.title, root).replace(/\.md$/, "");
	const dir = dirname(join(vaultRoot, `${base}.md`));
	mkdirSync(dir, { recursive: true });
	const body = renderMemory(value, links);

	// Claimed atomically rather than checked-then-written; see `atomic-write.ts`
	// for why, and for what the naive version cost.
	const claimed = claimFile(dir, body, (n) => `${basename(base)}${n === 1 ? "" : ` (${n})`}.md`, {
		exhaustedMessage: "too many same-titled memories on one day",
	});
	return { rel: `${dirname(base)}/${claimed.name}`.replace(/\\/g, "/"), full: claimed.full };
}

/** Read back what was written — used by tests and the post-write self-check. */
export function readMemory(vaultRoot: string, rel: string): string {
	return readFileSync(join(vaultRoot, rel), "utf8");
}
