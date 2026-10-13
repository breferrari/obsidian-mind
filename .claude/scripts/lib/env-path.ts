/**
 * A path the environment may override, for the hooks' state files (#360).
 *
 * Tests point these variables at temp files so parallel test workers don't
 * share state; production never sets them. An empty or blank value counts as
 * unset: `VAR=` with no value is common in shell and CI templates, and as the
 * path "" the file could be neither read nor written, so a debounce or a
 * dedupe built on it silently stops working.
 */
export function envPath(env: Readonly<Record<string, string | undefined>>, name: string, fallback: string): string {
	const set = env[name];
	return set?.trim() ? set : fallback;
}
