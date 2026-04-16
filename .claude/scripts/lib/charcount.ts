/**
 * Markdown section character counting.
 *
 * Extracts the body of a `### <section>` heading (optionally scoped to a
 * `**<sub>:**` marker inside it) and returns the character count with
 * newlines stripped. Used by review-writing workflows to enforce section
 * length budgets.
 *
 * Section body ends at the next `### ` or `## ` heading. When a sub-marker
 * is given, capture starts at that marker and ends at the next `**` line
 * (the next bold marker) or at a heading boundary.
 */

export type CountArgs = {
	readonly section: string;
	readonly sub?: string;
};

export function countSection(content: string, args: CountArgs): number {
	const lines = content.split("\n");
	const sectionHeader = `### ${args.section}`;
	const marker = args.sub ? `**${args.sub}:**` : null;

	let inSection = false;
	let capturing = marker === null;
	const captured: string[] = [];

	for (const line of lines) {
		if (!inSection) {
			if (line.includes(sectionHeader)) inSection = true;
			continue;
		}

		// Exit on next top-level heading
		if (line.startsWith("### ")) break;
		if (marker === null && line.startsWith("## ")) break;

		if (marker !== null) {
			if (!capturing) {
				if (line.includes(marker)) capturing = true;
				continue;
			}
			// Capturing under a marker — stop at next bold marker or heading
			if (line.startsWith("**")) break;
			if (line.startsWith("### ")) break;
		}

		if (line !== "") captured.push(line);
	}

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
