/**
 * Prose width (#247): a paragraph is one line.
 *
 * GitHub, and most renderers outside Obsidian's default, show a single
 * newline inside a paragraph as a real line break, so prose wrapped at ~70
 * columns reaches its reader broken mid-sentence. Worse, it propagates: a
 * session writes the shape it just read, and a vault full of wrapped notes
 * teaches the wrap to every session that reads them, into the next PR body.
 * An instruction did not beat the corpus; removing the examples did.
 *
 * `hardWrappedParagraphs` finds lines where a prose paragraph continues onto
 * a further line. STRUCTURE is never counted, because joining it is damage
 * that no word count notices: frontmatter (CRLF included), fenced code (```
 * and ~~~), HTML comments and raw HTML blocks, Obsidian `%%` comments, `$$`
 * math, tables and tab-separated rows, headings, list items and bare list
 * markers, indented lines (indented code, a list item's continuation),
 * field lines (`**Label:**` / `**Label**:`, one field per line by design),
 * embeds, callout and blockquote markers, and a line after an explicit hard
 * break (two trailing spaces or a backslash) or a lead-in ending in `:`.
 *
 * A note that is a raw capture — a pasted research dump, a benchmark log —
 * keeps its breaks on purpose: `verbatim: true` in its frontmatter opts it
 * out.
 */

const FENCE = /^(```|~~~)/;
const LIST_ITEM = /^(?:[-*+]|\d+[.)])(?:\s|$)/;
/**
 * A line led by a closed bold run: field lines (`**Door:** …`,
 * `**Blast radius**: …`) and `**1. Question?**` items, one per line by design.
 */
const BOLD_ITEM = /^\*\*[^*]+\*\*/;

/** True when this (already de-quoted) line is structure, never prose. */
function isStructure(line: string): boolean {
	return (
		line.trim() === "" ||
		/^\s/.test(line) ||
		line.startsWith("#") ||
		line.startsWith("|") ||
		line.includes("\t") ||
		LIST_ITEM.test(line) ||
		BOLD_ITEM.test(line) ||
		line.startsWith("<") ||
		line.startsWith("![[") ||
		line.startsWith("[!") ||
		/^-{3,}\s*$|^\*{3,}\s*$|^_{3,}\s*$/.test(line)
	);
}

/** Whether the note opts out with `verbatim: true` in its frontmatter. */
export function isVerbatim(content: string): boolean {
	const text = content.replace(/\r\n/g, "\n");
	if (!text.startsWith("---\n")) return false;
	const end = text.indexOf("\n---", 4);
	if (end === -1) return false;
	return /^verbatim:\s*true\s*$/m.test(text.slice(4, end));
}

/**
 * 1-based line numbers of every line that continues a prose paragraph from
 * the line above it. Empty for a note at zero, and for a `verbatim` note.
 */
export function hardWrappedParagraphs(content: string): number[] {
	if (isVerbatim(content)) return [];
	const lines = content.replace(/\r\n/g, "\n").split("\n");
	const out: number[] = [];

	let i = 0;
	if (lines[0] === "---") {
		const close = lines.indexOf("---", 1);
		i = close === -1 ? 0 : close + 1;
	}

	let fence: string | null = null;
	let inComment = false; // <!-- … -->
	let inObsidianComment = false; // %% … %%
	let inMath = false; // $$ … $$
	let previousProse = false;
	let previousQuoted = false;

	for (; i < lines.length; i++) {
		const raw = lines[i] ?? "";
		// A blockquote's content is judged without its marker, so a wrapped
		// paragraph inside a quote is still one, and a fence, comment or math
		// block inside a quote is still structure. A callout's `> [!type]`
		// title line is structure.
		const quoted = /^>/.test(raw);
		const line = quoted ? raw.replace(/^(?:>\s?)+/, "") : raw;
		const notProse = (): void => {
			previousProse = false;
		};

		if (fence !== null) {
			if (line.trimStart().startsWith(fence)) fence = null;
			notProse();
			continue;
		}
		const fenceOpen = FENCE.exec(line.trimStart());
		if (fenceOpen && !/^\s{4,}/.test(line)) {
			fence = fenceOpen[1] ?? null;
			notProse();
			continue;
		}
		if (inComment) {
			if (line.includes("-->")) inComment = false;
			notProse();
			continue;
		}
		if (line.trimStart().startsWith("<!--")) {
			inComment = !line.includes("-->");
			notProse();
			continue;
		}
		if (inObsidianComment) {
			if (line.includes("%%")) inObsidianComment = false;
			notProse();
			continue;
		}
		if (line.trimStart().startsWith("%%")) {
			// Opens a comment unless the same line also closes it.
			inObsidianComment = !line.trimStart().slice(2).includes("%%");
			notProse();
			continue;
		}
		if (line.trim() === "$$") {
			inMath = !inMath;
			notProse();
			continue;
		}
		if (inMath || isStructure(line)) {
			notProse();
			continue;
		}

		// A quote starts or ends a block: prose on either side of the boundary
		// is two blocks, not one wrapped paragraph.
		if (previousProse && quoted === previousQuoted) out.push(i + 1);
		// An explicit hard break (two trailing spaces, or a backslash) ends the
		// line on purpose, and a line ending in `:` is a lead-in ("Content to
		// process:" above its placeholder): what follows either is not a wrap.
		previousProse = !/(?: {2}|\\|:)$/.test(raw);
		previousQuoted = quoted;
	}
	return out;
}
