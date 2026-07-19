/**
 * Duplication-guard (#115): AGENTS.md and GEMINI.md are the same pointer
 * doc by design — two filenames because two agent ecosystems look for
 * them, one content because they say the same thing. When duplication IS
 * the design, guard it with a test so the copies can't drift silently.
 * (The pattern matters more than the instance: apply it wherever the same
 * instruction text must exist in two places that can't reference each
 * other.)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("agent docs sync", () => {
	test("AGENTS.md and GEMINI.md are byte-identical", () => {
		const agents = readFileSync(resolve(repoRoot, "AGENTS.md"), "utf-8");
		const gemini = readFileSync(resolve(repoRoot, "GEMINI.md"), "utf-8");
		assert.equal(
			agents,
			gemini,
			"AGENTS.md and GEMINI.md drifted — they are the same pointer doc by design; edit both or neither",
		);
	});
});
