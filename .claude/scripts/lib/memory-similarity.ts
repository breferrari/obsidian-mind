/**
 * Near-duplicate detection for the vault memory layer.
 *
 * WHY THIS EXISTS
 *
 * A memory store without a duplicate guard degrades as it grows, and it degrades
 * in the worst possible way: silently, and fastest for the lessons that matter
 * most. The same constraint gets rediscovered every few weeks by a session that
 * could not find the earlier note, and each rediscovery writes another copy — so
 * the most important lessons end up the most duplicated, retrieval returns five
 * near-identical hits, and the reader trusts the store less exactly where it
 * should trust it more.
 *
 * Deliberately lexical, not semantic. An embedding call on every write would
 * cost latency and money on the hot path, and the failure it prevents is the
 * *literal* re-record — a session restating a lesson in near-identical words,
 * not two genuinely different phrasings of one idea. The semantic case is what
 * retrieval is for; this is a write-time guard against obvious repetition.
 *
 * All pure. No IO, no index, no network.
 */

/** The facets that decide whether two memories can even be compared. */
export interface Comparable {
	readonly title: string;
	readonly body: string;
	readonly scope?: string;
	readonly projects?: readonly string[];
	readonly platforms?: readonly string[];
}

export interface SimilarHit<T> {
	readonly entry: T;
	readonly score: number;
}

/** Words carrying no discriminating signal in a technical note. */
const STOP = new Set([
	"a","an","the","and","or","but","if","then","else","when","while","for","to","of","in","on","at","by","from","with",
	"is","are","was","were","be","been","being","it","its","this","that","these","those","as","so","not","no","do","does",
	"did","can","could","will","would","should","may","might","must","have","has","had","you","your","we","our","they",
	"their","he","she","i","me","my","us","them","there","here","what","which","who","whom","how","why","because","into",
	"than","too","very","just","also","only","own","same","up","down","out","over","under","again","more","most","some",
]);

/**
 * Plural folding, and nothing more.
 *
 * Without it "patch" and "patches" are different tokens, which alone drags a
 * near-verbatim restatement below the duplicate threshold — measured at 0.800
 * before this was added, where the same pair scores 1.000 after. A full stemmer
 * would be worse than useless: it collapses distinct technical terms and costs
 * precision on exactly the identifiers that carry the signal.
 */
export function stem(token: string): string {
	if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
	if (token.length > 4 && /(?:s|x|z|ch|sh)es$/.test(token)) return token.slice(0, -2);
	if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
		const candidate = token.slice(0, -1);
		// A stem with no vowel is not a word, it is an acronym or a scheme —
		// `https` must not fold into `http`, because that is a distinction a
		// technical note is often written specifically to make.
		if (/[aeiou]/.test(candidate)) return candidate;
	}
	return token;
}

/**
 * Normalize text to a comparable token bag.
 *
 * Numbers are preserved: two memories differing only in a version number are
 * NOT duplicates, and that difference is usually the entire point of the second
 * one. `_` survives the markdown pass because it is part of an identifier far
 * more often than it is emphasis — splitting `node_modules` into two tokens
 * throws away the most discriminating word in a technical note.
 */
export function tokenize(text: unknown): string[] {
	return String(text ?? "")
		.toLowerCase()
		.replace(/[`*~>#[\]()]/g, " ")
		.replace(/[^a-z0-9._/-]+/g, " ")
		.split(/\s+/)
		.map((t) => t.replace(/^[._/-]+|[._/-]+$/g, ""))
		.filter((t) => t.length > 1 && !STOP.has(t))
		.map(stem);
}

/** Jaccard: shared tokens over total distinct tokens. 0 → disjoint, 1 → identical. */
export function jaccard(aTokens: readonly string[], bTokens: readonly string[]): number {
	const a = new Set(aTokens);
	const b = new Set(bTokens);
	if (a.size === 0 && b.size === 0) return 1;
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const t of a) if (b.has(t)) shared++;
	return shared / (a.size + b.size - shared);
}

/**
 * Similarity between two memories, title-weighted.
 *
 * The title is where a session states the lesson in its most compressed form, so
 * two memories with near-identical titles are near-identical memories almost
 * regardless of how differently the bodies ramble. Body agreement alone is a
 * weaker signal — two notes about the same subsystem share a lot of vocabulary
 * without being the same lesson.
 */
export function similarity(a: Comparable, b: Comparable): number {
	const titleScore = jaccard(tokenize(a.title), tokenize(b.title));
	const bodyScore = jaccard(tokenize(a.body), tokenize(b.body));
	return 0.6 * titleScore + 0.4 * bodyScore;
}

/**
 * Thresholds, chosen from measurement rather than feel.
 *
 * Measured against a real memory and five comparison texts:
 *
 *   near-verbatim restatement        1.000
 *   same lesson, reworded            0.497
 *   adjacent note, same subsystem    0.071
 *   different lesson, same subsystem 0.060
 *   unrelated                        0.000
 *
 * The gap between a reworded restatement and a merely adjacent note is where
 * the useful signal lives, so the bands sit either side of it. An earlier guess
 * put these at 0.82 / 0.45 — the first missed verbatim restatements and the
 * second could never fire on real text. Both were fixed by measuring.
 *
 * `DUPLICATE` stays deliberately high: a false positive here suppresses a real
 * memory, which is the expensive error.
 */
export const DUPLICATE = 0.75;

/**
 * Possible restatement in different words. Advisory only: the write proceeds,
 * the caller is told, and a link is proposed. A false positive costs one
 * suggested link.
 */
export const RELATED = 0.35;

/**
 * Do these two memories reach any of the same readers?
 *
 * If they do not they cannot be duplicates in any sense that matters — nobody
 * will ever see both. This is what stops the guard suppressing a legitimate
 * per-project copy of the same lesson.
 */
export function sharesFacet(a: Comparable, b: Comparable): boolean {
	const scopeA = a.scope ?? "project";
	const scopeB = b.scope ?? "project";
	if (scopeA === "general" || scopeB === "general") return true;
	const lower = (xs?: readonly string[]): string[] => (xs ?? []).map((x) => String(x).toLowerCase());
	const pa = lower(a.projects);
	const pb = lower(b.projects);
	if (pa.some((p) => pb.includes(p))) return true;
	const la = lower(a.platforms);
	const lb = lower(b.platforms);
	if (scopeA === "platform" && scopeB === "platform" && la.some((p) => lb.includes(p))) return true;
	return false;
}

/**
 * Compare a candidate against existing memories.
 *
 * Only memories the candidate could actually collide with are compared. Two
 * identically-worded notes scoped to different projects are not duplicates:
 * each project's session needs its own copy, because neither can see the other's.
 */
export function findSimilar<T extends Comparable>(
	candidate: Comparable,
	existing: readonly T[],
	{ duplicate = DUPLICATE, related = RELATED }: { duplicate?: number; related?: number } = {},
): { duplicates: SimilarHit<T>[]; related: SimilarHit<T>[] } {
	const duplicates: SimilarHit<T>[] = [];
	const relatedTo: SimilarHit<T>[] = [];
	for (const entry of existing) {
		if (!sharesFacet(candidate, entry)) continue;
		const score = similarity(candidate, entry);
		if (score >= duplicate) duplicates.push({ entry, score });
		else if (score >= related) relatedTo.push({ entry, score });
	}
	duplicates.sort((x, y) => y.score - x.score);
	relatedTo.sort((x, y) => y.score - x.score);
	return { duplicates, related: relatedTo };
}
