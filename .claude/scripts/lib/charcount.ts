/**
 * Markdown section character counting.
 *
 * Extracts the body of a `## <section>` or `### <section>` heading
 * (optionally scoped to a `**<sub>:**` marker inside it) and returns the
 * character count with newlines stripped. Used by review-writing workflows
 * to enforce section length budgets.
 *
 * A heading names the section when its text is exactly `<section>`, or is
 * `<section>` followed by a separator and a suffix — `## Impact -- "What was
 * delivered?"` is the section "Impact", as the review template writes it. A
 * longer word (`### Impact Summary`) is a different section. An exact match
 * wins over a suffixed one wherever it sits in the file.
 *
 * The section body ends at the next heading of the same or a higher level,
 * so a `##` section keeps its `###` children. When a sub-marker is given,
 * capture starts at that marker and ends at the next `**` line (the next
 * bold marker) or at that same heading boundary.
 *
 * A section or marker that is not in the file returns `null`, never `0`: a
 * zero count would pass every limit, and "checked and short" must stay
 * distinguishable from "never found".
 */

export type CountArgs = {
	readonly section: string;
	readonly sub?: string;
};

const HEADING = /^(#{1,6})\s+(.*?)\s*$/;

/** Separators that may follow the section name before a heading's suffix. */
const SUFFIX = /^\s*(?:--|—|–|-|:|\(|\|)/;

type Heading = { readonly level: number; readonly text: string };

function parseHeading(line: string): Heading | null {
	const m = HEADING.exec(line);
	if (!m) return null;
	return { level: (m[1] as string).length, text: m[2] as string };
}

/** 2 for an exact name match, 1 for name + separator suffix, 0 otherwise. */
function matchRank(h: Heading, section: string): number {
	if (h.level !== 2 && h.level !== 3) return 0;
	const name = section.trim();
	if (h.text === name) return 2;
	if (h.text.startsWith(name) && SUFFIX.test(h.text.slice(name.length))) return 1;
	return 0;
}

export function countSection(content: string, args: CountArgs): number | null {
	const lines = content.split(/\r?\n/);

	let start = -1;
	let bestRank = 0;
	for (let i = 0; i < lines.length && bestRank < 2; i++) {
		const h = parseHeading(lines[i] as string);
		if (!h) continue;
		const rank = matchRank(h, args.section);
		if (rank > bestRank) {
			bestRank = rank;
			start = i;
		}
	}
	if (start === -1) return null;

	const level = (parseHeading(lines[start] as string) as Heading).level;
	const marker = args.sub ? `**${args.sub}:**` : null;
	let capturing = marker === null;
	const captured: string[] = [];

	for (const line of lines.slice(start + 1)) {
		const h = parseHeading(line);
		if (h && h.level <= level) break;

		if (marker !== null) {
			if (!capturing) {
				if (line.includes(marker)) capturing = true;
				continue;
			}
			// Capturing under a marker — stop at the next bold marker
			if (line.startsWith("**")) break;
		}

		if (line !== "") captured.push(line);
	}

	if (!capturing) return null;
	return captured.join("").length;
}

export type FormatResult = {
	readonly ok: boolean;
	readonly output: string;
};

export function formatResult(count: number, limit?: number): FormatResult {
	if (limit === undefined) {
		return { ok: true, output: String(count) };
	}
	if (count <= limit) {
		return { ok: true, output: `${count}/${limit} ✓` };
	}
	const over = count - limit;
	return { ok: false, output: `${count}/${limit} ✗ (over by ${over})` };
}
