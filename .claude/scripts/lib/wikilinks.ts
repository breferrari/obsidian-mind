/**
 * Wikilink extraction + resolution — pure helpers behind the vault's
 * broken-link zero gate (tests/vault-wikilinks.test.ts).
 *
 * Resolution implements the vault's link semantics, deliberately including
 * one assumption beyond stock Obsidian: a `[[target]]` also RESOLVES when
 * some file lists the target in its frontmatter `aliases:`. Alias links
 * are the vault's dominant idiom — `[[obsidian-mind]]` (×144) and
 * `[[ShardMind]]` (×138) point at project READMEs via aliases — and the
 * graph treats them as edges, so the gate must too.
 *
 * Rules:
 *  - Fenced code blocks AND inline code spans are stripped before
 *    extraction — CLAUDE.md and the skills carry literal `[[...]]`
 *    syntax examples that are documentation, not edges.
 *  - `!` embed prefix, `|alias` tails (including the table-escaped `\|`
 *    form), `#heading` and `#^block` fragments are stripped from targets.
 *  - `[[#Heading]]` (same-file anchor) always resolves.
 *  - `{{placeholder}}` targets (templates) and non-note asset targets
 *    (.png, .canvas, …) are ignored — the gate covers note edges only.
 *  - `./` / `../` targets resolve against the source file's directory;
 *    `/`-containing targets also resolve by path suffix (Obsidian
 *    shortest-path semantics, approximated); bare targets resolve by
 *    case-insensitive basename or alias.
 */

const ASSET_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"svg",
	"webp",
	"pdf",
	"canvas",
	"base",
	"excalidraw",
	"html",
	"htm",
	"mp3",
	"mp4",
	"mov",
	"zip",
]);

/**
 * Remove fenced code blocks (``` / ~~~) and inline code spans so literal
 * wikilink examples inside them never count as edges. Fence-aware line
 * scan (not a lazy regex) so an unclosed fence strips to EOF instead of
 * leaking the tail.
 */
export function stripCodeRegions(content: string): string {
	const out: string[] = [];
	let inFence = false;
	let fenceMarker = "";
	for (const line of content.split("\n")) {
		const trimmed = line.trimStart();
		if (inFence) {
			if (trimmed.startsWith(fenceMarker)) inFence = false;
			continue;
		}
		if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
			inFence = true;
			fenceMarker = trimmed.slice(0, 3);
			continue;
		}
		// Inline code spans: remove `...` runs, including multi-backtick
		// spans (``…`` — CommonMark closes N backticks with exactly N, and
		// shorter runs are legal INSIDE the span, so ``[[x]]`` and
		// ``code with ` inside`` must both strip whole). Content charwise
		// forbids starting the same-length run early; the trailing (?!`)
		// pins the closer to an exact-length run.
		out.push(line.replace(/(`+)(?:(?!\1)[^\n])*?\1(?!`)/g, ""));
	}
	return out.join("\n");
}

/**
 * Extract resolution targets from every `[[...]]` in the content
 * (code regions pre-stripped). Returns raw target strings — alias tails,
 * fragments, and embed prefixes removed; empties/placeholders/assets
 * dropped.
 */
export function extractWikilinkTargets(content: string): string[] {
	const targets: string[] = [];
	const re = /!?\[\[([^\[\]\n]+?)\]\]/g;
	for (const m of stripCodeRegions(content).matchAll(re)) {
		let inner = m[1] ?? "";
		// Table-escaped alias pipes — both forms Obsidian accepts inside
		// tables: backslash (`[[Target\|alias]]`) and HTML entity
		// (`[[Target&#124;alias]]`). Normalize before splitting so the
		// target doesn't keep a trailing `\` or `&`.
		inner = inner.replaceAll("\\|", "|").replaceAll("&#124;", "|");
		const target = (inner.split("|")[0] ?? "").split("#")[0]?.trim() ?? "";
		if (target === "") continue; // [[#heading]] / [[|alias]] — same-file
		if (target.includes("{{")) continue; // template placeholder
		const ext = target.includes(".")
			? (target.split(".").pop() ?? "").toLowerCase()
			: "";
		if (ASSET_EXTENSIONS.has(ext)) continue;
		targets.push(target);
	}
	return targets;
}

/**
 * Minimal frontmatter `aliases:` reader — YAML block list and inline
 * `[a, b]` forms, quoted or bare. Returns [] when absent/malformed.
 */
export function extractAliases(content: string): string[] {
	if (!content.startsWith("---")) return [];
	const end = content.indexOf("\n---", 3);
	if (end === -1) return [];
	const fm = content.slice(3, end);
	const lines = fm.split("\n");
	const idx = lines.findIndex((l) => /^aliases:\s*(\[.*\])?\s*$/.test(l.trim()) || /^aliases:\s*\[/.test(l.trim()));
	if (idx === -1) return [];
	const head = lines[idx]?.trim() ?? "";
	const unquote = (s: string): string => {
		const t = s.trim();
		if (
			(t.startsWith('"') && t.endsWith('"')) ||
			(t.startsWith("'") && t.endsWith("'"))
		) {
			return t.slice(1, -1);
		}
		return t;
	};
	const inline = head.match(/^aliases:\s*\[(.*)\]\s*$/);
	if (inline) {
		return (inline[1] ?? "")
			.split(",")
			.map(unquote)
			.filter((s) => s !== "");
	}
	const out: string[] = [];
	for (let i = idx + 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const item = line.match(/^\s+-\s+(.*)$/);
		if (!item) break; // end of the block list
		const value = unquote(item[1] ?? "");
		if (value !== "") out.push(value);
	}
	return out;
}

const stripMdExt = (p: string): string => p.replace(/\.md$/i, "");

/** POSIX-normalize `dir/../x` style paths; returns null when escaping root. */
function normalizeRelative(path: string): string | null {
	const parts: string[] = [];
	for (const seg of path.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			if (parts.length === 0) return null;
			parts.pop();
			continue;
		}
		parts.push(seg);
	}
	return parts.join("/");
}

export type Resolver = (target: string, sourceRelPath: string) => boolean;

/**
 * Build a resolver over the vault's file set.
 *
 * @param files vault-relative POSIX paths of every .md file (target set)
 * @param aliasesByFile frontmatter aliases per file (same path keys)
 */
export function buildResolver(
	files: readonly string[],
	aliasesByFile: ReadonlyMap<string, readonly string[]>,
): Resolver {
	const pathSet = new Set(files.map((f) => stripMdExt(f).toLowerCase()));
	const basenames = new Set(
		files.map((f) => {
			const base = f.split("/").pop() ?? f;
			return stripMdExt(base).toLowerCase();
		}),
	);
	const aliases = new Set(
		[...aliasesByFile.values()].flat().map((a) => a.toLowerCase()),
	);

	return (target: string, sourceRelPath: string): boolean => {
		const clean = stripMdExt(target.replace(/\\/g, "/")).toLowerCase();

		// Source-relative (./ or ../) — resolve against the source's dir.
		if (clean.startsWith("./") || clean.startsWith("../")) {
			const sourceDir = sourceRelPath
				.replace(/\\/g, "/")
				.toLowerCase()
				.split("/")
				.slice(0, -1)
				.join("/");
			const resolved = normalizeRelative(
				sourceDir === "" ? clean : `${sourceDir}/${clean}`,
			);
			return resolved !== null && pathSet.has(resolved);
		}

		// Path-form target — exact vault path or unambiguous suffix.
		if (clean.includes("/")) {
			if (pathSet.has(clean)) return true;
			for (const p of pathSet) {
				if (p.endsWith(`/${clean}`)) return true;
			}
			return false;
		}

		// Bare name — basename or alias.
		return basenames.has(clean) || aliases.has(clean);
	};
}
