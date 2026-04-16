/**
 * Tiny bin for shell-invoked JSON field extraction.
 *
 * Usage: echo '{"a":1,"b":"x"}' | node --experimental-strip-types read-field.ts a b
 * Output: `1\tx`  (tab-separated, in argv order)
 *
 * Replaces the old inline `python -c "import json,sys; print(...)"` pattern
 * used inside pre-compact.sh and the Stop hook in settings.json.
 */

import { readStdinJson } from "./hook-io.ts";

const input = await readStdinJson<Record<string, unknown>>();
const fields = process.argv.slice(2);
const values = fields.map((f) => {
	const v = input?.[f];
	if (v === undefined || v === null) return "";
	return String(v);
});
process.stdout.write(values.join("\t"));
