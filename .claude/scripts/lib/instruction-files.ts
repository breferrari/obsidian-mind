/**
 * The vault's instruction files (#321). `AGENTS.md` is the one every agent
 * reads. A retired one left at the vault root goes wrong silently, each its
 * own way: Claude Code reads a `CLAUDE.md` in place of `AGENTS.md`, and
 * Gemini, which now reads `AGENTS.md` through `.gemini/settings.json`, never
 * loads a `GEMINI.md`, so whatever the user added there is lost. The hygiene
 * scan and `upgrade-plan` both read this list, so a file retired later is
 * retired in one place.
 */

export const INSTRUCTION_FILE = "AGENTS.md";
export const CLAUDE_MD = "CLAUDE.md";
export const GEMINI_MD = "GEMINI.md";

/**
 * Gemini's settings, whose `context.fileName` points it at `AGENTS.md`. A
 * user's own older copy names no context file, so Gemini reads `GEMINI.md`,
 * which in the old release only says "read CLAUDE.md".
 */
export const GEMINI_SETTINGS = ".gemini/settings.json";

/**
 * The size `AGENTS.md` stays under. Measured 2026-10-06 (#321): Antigravity
 * 1.3.0 truncated a 36 KB `AGENTS.md` between byte 23,860 and byte 24,305,
 * silently, and Codex CLI 0.160.0 stopped consistent with a 32 KiB cap; this
 * leaves ~2 KB of margin under the first. The template's own
 * test fails at it.
 */
export const AGENTS_MD_MAX_BYTES = 22_000;

/**
 * Where the hygiene scan flags a vault's own AGENTS.md: 1 KB above the
 * template's cap, so a user's first additions are not a finding, and still
 * under byte 23,860, the last one Antigravity was seen to read.
 */
export const AGENTS_MD_FLAG_BYTES = 23_000;

export const RETIRED_INSTRUCTION_FILES: readonly string[] = [CLAUDE_MD, GEMINI_MD];

/**
 * Whether a root file name is a retired instruction file, ignoring case:
 * Windows and macOS resolve `claude.md` as `CLAUDE.md`, so an agent loads it.
 */
export function isRetiredInstructionFile(name: string): boolean {
	const lower = name.toLowerCase();
	return RETIRED_INSTRUCTION_FILES.some((f) => f.toLowerCase() === lower);
}
