/**
 * The vault's instruction files (#321). `AGENTS.md` is the one every agent
 * reads. A retired one left at the vault root still loads for some agent and
 * displaces it: Claude Code reads a `CLAUDE.md` in place of `AGENTS.md`,
 * silently. The hygiene scan and `upgrade-plan` both read this list, so a file
 * retired later is retired in one place.
 */

export const INSTRUCTION_FILE = "AGENTS.md";

/**
 * The size `AGENTS.md` stays under. Antigravity truncated a 36 KB `AGENTS.md`
 * between byte 23,860 and byte 24,305, silently (#321), and Codex stops at
 * ~32 KiB; this leaves ~2 KB of margin under the first. The template's own
 * test fails at it, and the hygiene scan flags a vault's copy that reaches it.
 */
export const AGENTS_MD_MAX_BYTES = 22_000;

export const RETIRED_INSTRUCTION_FILES: readonly string[] = ["CLAUDE.md"];

/**
 * Whether a root file name is a retired instruction file, ignoring case:
 * Windows and macOS resolve `claude.md` as `CLAUDE.md`, so an agent loads it.
 */
export function isRetiredInstructionFile(name: string): boolean {
	const lower = name.toLowerCase();
	return RETIRED_INSTRUCTION_FILES.some((f) => f.toLowerCase() === lower);
}
