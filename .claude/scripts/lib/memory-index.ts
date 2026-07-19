/**
 * MEMORY.md generation (#125) — the auto-memory index as a DERIVED view.
 *
 * CLAUDE.md doctrine: `~/.claude/.../memory/MEMORY.md` is an auto-loaded
 * index ONLY — pointers to brain/ topic notes, never content. The doctrine
 * only holds if the index is derivable: the moment authored knowledge
 * accumulates there, it forks the source of truth and silently desyncs
 * from the vault. This module makes it derivable — deterministic output
 * from brain/ sources, byte-for-byte reproducible, so nothing authored
 * can be lost on regeneration because nothing authored is permitted.
 */

export type BrainNote = {
	/** Note name without extension, e.g. "Gotchas". */
	readonly name: string;
	/** Frontmatter description, or null when absent. */
	readonly description: string | null;
};

export const MEMORY_INDEX_HEADER =
	"All durable memory lives in the vault under `brain/` per CLAUDE.md. " +
	"This index points to vault topic notes — never write content here. " +
	"Regenerated from brain/ frontmatter (see `generate-memory-index.ts`); " +
	"hand edits will be overwritten.";

/**
 * Render the pointer-list index. Deterministic: notes are sorted by name
 * (case-insensitive), the same input always produces the same bytes.
 */
export function generateMemoryIndex(notes: readonly BrainNote[]): string {
	const sorted = [...notes].sort((a, b) =>
		a.name.toLowerCase().localeCompare(b.name.toLowerCase(), "en"),
	);
	const lines = [MEMORY_INDEX_HEADER, ""];
	for (const n of sorted) {
		lines.push(`- [[brain/${n.name}]] — ${n.description ?? "(no description)"}`);
	}
	return lines.join("\n") + "\n";
}
