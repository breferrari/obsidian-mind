/**
 * The instruction a Claude Code mod passes to a hook script on the event
 * itself (#264).
 *
 * A mod wraps each settings-hook event as `classic.<Event>` and runs before
 * the settings hooks beneath it; what it passes to `next()` is exactly what
 * those hooks read on stdin. So when the template's mod takes an event over,
 * it calls `next({ ...e, om_mod: "standdown" })` and the script exits without
 * output or side effects, and when it wants the script's output for a
 * channel of its own, it runs the script itself with `deliver` or `report`.
 *
 * The flag is the switch because it fails safe: it exists only on an event
 * whose mod hook actually ran. A mod that throws before `next`, crashed, was
 * blocked by policy or never loaded passes the original event down, and the
 * script runs exactly as it does without a mod. Codex and Gemini never load
 * mods, so they never send it. An environment variable would not have that
 * property: it outlives a mod that died, and the scripts would stand down
 * with nothing delivering.
 *
 * Each script honours only the modes meant for it and ignores the rest,
 * including any unknown value, so a typo or a newer mod degrades to today's
 * behaviour rather than to silence.
 */

/**
 * - `standdown`: the mod delivers this event; print nothing, do nothing.
 * - `deliver`: the mod delivers this output as an instruction file, not as
 *   hook output, so the hook-output cap does not apply.
 * - `report`: return the Stop report as data for the mod to present.
 */
export type OmMod = "standdown" | "deliver" | "report";

const OM_MODS: ReadonlySet<string> = new Set<OmMod>(["standdown", "deliver", "report"]);

/** The `om_mod` instruction on a hook's parsed input, or null when absent or unknown. */
export function readOmMod(input: unknown): OmMod | null {
	if (input === null || typeof input !== "object") return null;
	const value = (input as { readonly om_mod?: unknown }).om_mod;
	return typeof value === "string" && OM_MODS.has(value) ? (value as OmMod) : null;
}
