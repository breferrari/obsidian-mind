/**
 * The vault's instruction files (#321). `AGENTS.md` is the one every agent
 * reads. A retired one left at the vault root still loads for some agent and
 * displaces it: Claude Code reads a `CLAUDE.md` in place of `AGENTS.md`,
 * silently. The hygiene scan and `upgrade-plan` both read this list, so a file
 * retired later is retired in one place.
 */

export const INSTRUCTION_FILE = "AGENTS.md";

export const RETIRED_INSTRUCTION_FILES: readonly string[] = ["CLAUDE.md"];
