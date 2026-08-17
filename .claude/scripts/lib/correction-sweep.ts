/**
 * The correction sweep — the judgement half.
 *
 * WHY THIS EXISTS
 *
 * `CLAUDE.md` Law 2 instructs a sweep: when a fact is corrected, find every
 * restatement and fix them all in the same pass. Nothing in the vault helped do
 * it. Every existing check is about a note's SHAPE — frontmatter present,
 * wikilinks resolve, size under the split threshold, orphans, stale actives —
 * and none is about whether what a note SAYS is still true. A note can be
 * structurally perfect and assert a fact the vault corrected months ago, and it
 * keeps feeding that fact to every session that reads it.
 *
 * Worse, `signals.ts` already tells the agent to sweep on a decision reversal.
 * So on the one path where the vault detects a correction happening, it issued
 * an instruction and handed over nothing to act with — an instruction that looks
 * like a control and cannot act.
 *
 * WHY THE PREDICATE IS THE CORE, NOT THE SEARCH
 *
 * Finding candidates is the easy half. The dangerous half is deciding what may
 * be edited, because the three categories need OPPOSITE treatment:
 *
 *   AUTHORITATIVE  the single-source note Law 1 designates. The correction is
 *                  APPLIED here. Exactly one, and it is the only note whose
 *                  claim is rewritten.
 *   RESTATEMENT    a living note asserting the fact that should be linking to
 *                  the source instead. Per Law 1 it is replaced with a link,
 *                  which fixes today's stain and prevents the next one.
 *   HISTORICAL     a note that correctly records what was believed AT THE TIME.
 *                  Rewriting it destroys a true record.
 *
 * A sweep that cannot tell a stale claim from a historical record is worse than
 * no sweep. It silently rewrites the vault's memory of what it used to believe,
 * and that damage is both unrecoverable and invisible, because the note still
 * reads fine afterwards. Law 5 warns about exactly this class of
 * over-correction: an attribution quarter differing from a creation date "is
 * legitimate, not a bug to fix". A sweep enthusiastic about consistency is how
 * that law gets violated at scale.
 *
 * So the predicate is isolated here and pinned by tests, the way
 * `isMonolithExempt` isolates the judgement the monolith sensor depends on. The
 * command around it is thin orchestration.
 *
 * TWO RULES DECIDED DELIBERATELY, NOT INHERITED
 *
 * 1. Historical is keyed on BOTH the naming convention AND explicit signals.
 *    The convention alone (`CLAUDE.md` § Creating Notes: point-in-time notes
 *    carry a date, living notes do not) is the right instinct but too fragile to
 *    be the only signal — it silently misclassifies the moment someone names a
 *    file differently. Frontmatter `status` and the archive/log directories say
 *    the same thing explicitly, and any ONE of them is enough.
 *
 * 2. A historical note is NEVER edited. It is reported and preserved, always.
 *    Not "edited carefully", not "edited with a callout". The asymmetry is the
 *    whole point: a missed restatement is a stale claim someone will notice and
 *    can fix later, while a rewritten record is a true thing destroyed with no
 *    trace that it ever said otherwise.
 *
 * All pure. No IO, no index, no network — the search arms and the file writes
 * live in the command and its agent.
 */

/** What may be done to a note carrying the corrected fact. */
export type NoteClass = "AUTHORITATIVE" | "RESTATEMENT" | "HISTORICAL";

/** A candidate the search arms turned up. */
export interface SweepCandidate {
	/** Vault-relative POSIX path. */
	readonly rel: string;
	/** Parsed frontmatter; `{}` when the note has none. */
	readonly frontmatter: Record<string, unknown>;
}

/**
 * Directories whose contents are records of a moment by construction.
 *
 * Matched on a path SEGMENT rather than a substring, so a living note that
 * merely contains the word (`work/archive-policy.md`) is not swept into the
 * exemption. `thinking/` is included because a scratchpad records reasoning as
 * it stood; `memories/` because captures carry their own supersession machinery
 * and a text sweep editing them would fight it.
 */
const HISTORICAL_DIRS = new Set(["archive", "1-1", "meetings", "thinking", "memories", "journal", "incidents"]);

/**
 * Frontmatter `status` values that mark a note as a closed record.
 *
 * `completed` is included on purpose. A finished piece of work describes what
 * was done, and editing it to agree with the present falsifies the record just
 * as surely as editing a dated capture would.
 */
const HISTORICAL_STATUS = new Set(["superseded", "archived", "completed", "deprecated", "done"]);

/** A date anywhere in the filename, not only as a prefix. */
const DATE_IN_NAME = /\d{4}-\d{2}-\d{2}/;

/**
 * Does this note record a moment rather than assert a present fact?
 *
 * Any one signal is enough. They are deliberately redundant: the naming
 * convention catches what the frontmatter forgot, and the frontmatter catches
 * what a rename broke.
 *
 * Note that `date:` in frontmatter is NOT a signal. Every note in this vault has
 * one, so treating it as evidence would classify the entire vault as historical
 * and turn the sweep into an expensive no-op.
 */
export function isHistoricalNote(
	relPath: string,
	frontmatter: Record<string, unknown> = {},
): boolean {
	const rel = String(relPath ?? "").replace(/\\/g, "/");
	if (rel === "") return false;

	const segments = rel.split("/");
	const fileName = segments.pop() ?? "";

	// 1. A record-keeping directory anywhere in the path.
	if (segments.some((s) => HISTORICAL_DIRS.has(s.toLowerCase()))) return true;

	// 2. A date in the filename — the convention's own marker for point-in-time.
	if (DATE_IN_NAME.test(fileName)) return true;

	// 3. An explicit status saying the note is closed.
	const status = frontmatter?.["status"];
	if (typeof status === "string" && HISTORICAL_STATUS.has(status.trim().toLowerCase())) return true;

	return false;
}

/**
 * Classify one candidate.
 *
 * The authoritative note is passed in rather than inferred, because nothing in
 * the vault can decide which of two contradicting notes is true — only the
 * person making the correction knows, which is why the sweep takes the corrected
 * fact as an argument in the first place.
 *
 * HISTORICAL is checked BEFORE authoritative on purpose. If the single-source
 * note has itself been archived or superseded, the correction belongs in
 * whatever replaced it, and rewriting the retired one would be the exact damage
 * this module exists to prevent.
 */
export function classifyCandidate(
	candidate: SweepCandidate,
	authoritativeRel: string | null,
): NoteClass {
	if (isHistoricalNote(candidate.rel, candidate.frontmatter)) return "HISTORICAL";
	if (authoritativeRel && samePath(candidate.rel, authoritativeRel)) return "AUTHORITATIVE";
	return "RESTATEMENT";
}

const samePath = (a: string, b: string): boolean =>
	String(a).replace(/\\/g, "/").toLowerCase() === String(b).replace(/\\/g, "/").toLowerCase();

export interface SweepPlan {
	/** The one note whose claim is rewritten. */
	readonly apply: SweepCandidate | null;
	/** Living notes whose restatement becomes a link to the source. */
	readonly replaceWithLink: SweepCandidate[];
	/** Records left exactly as they are, reported so the omission is visible. */
	readonly preserve: SweepCandidate[];
	/**
	 * Candidates that would have been edited had the authoritative note been
	 * named. Kept separate rather than silently folded into `replaceWithLink`,
	 * because replacing every restatement with a link to a source that was never
	 * corrected propagates the stale claim behind a link instead of removing it.
	 */
	readonly blocked: SweepCandidate[];
}

/**
 * Turn classified candidates into what the command will actually do.
 *
 * Refuses to plan edits when no authoritative note is designated. Law 1 puts the
 * fact in exactly one place; without knowing where that is, "replace this
 * restatement with a link" has nowhere correct to point, and applying the
 * correction to several notes at once recreates the very duplication the law
 * exists to prevent.
 */
export function planSweep(
	candidates: readonly SweepCandidate[],
	authoritativeRel: string | null,
): SweepPlan {
	const apply: SweepCandidate[] = [];
	const replaceWithLink: SweepCandidate[] = [];
	const preserve: SweepCandidate[] = [];

	for (const c of candidates) {
		const klass = classifyCandidate(c, authoritativeRel);
		if (klass === "HISTORICAL") preserve.push(c);
		else if (klass === "AUTHORITATIVE") apply.push(c);
		else replaceWithLink.push(c);
	}

	if (!authoritativeRel || apply.length === 0) {
		return { apply: null, replaceWithLink: [], preserve, blocked: replaceWithLink };
	}
	return { apply: apply[0] ?? null, replaceWithLink, preserve, blocked: [] };
}
