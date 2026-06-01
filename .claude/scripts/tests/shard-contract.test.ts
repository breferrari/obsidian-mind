/**
 * Shard manifest contract tests.
 *
 * Pins the ShardMind hook-lifecycle migration (#75) and the engine-coupling
 * invariant it introduced: a shard that declares the split `bootstrap` /
 * `personalize` slots MUST also declare `requires.shardmind` at the floor that
 * understands them (>=0.1.3). Without that floor an older engine silently
 * skips the unknown slots — no git init, no QMD index, no personalization —
 * instead of refusing the install. This test fails loudly if a future edit
 * drops the floor, re-introduces the deprecated single `post-install` slot
 * (which would dual-fire against the native slots on a >=0.1.3 engine), or
 * removes one of the three lifecycle hooks.
 *
 * Zero-dep by design: there's no YAML parser in the hook runtime, and
 * `.shardmind/shard.yaml` is a file we own, so a line-oriented scan is robust
 * enough and keeps the test dependency-free (matching the JSON-reading
 * `hook-config.test.ts`). Path resolution is CWD-independent (via
 * `import.meta.url`) so the test passes both under `npm test` (cwd
 * `.claude/scripts`) and under release.yml's repo-root invocation.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const shardYaml = readFileSync(resolve(repoRoot, ".shardmind/shard.yaml"), {
	encoding: "utf-8",
});

/** Lowest shardmind engine that understands the split hook lifecycle. */
const MIN_SHARDMIND: readonly [number, number, number] = [0, 1, 3];

function gte(
	a: readonly [number, number, number],
	b: readonly [number, number, number],
): boolean {
	for (let i = 0; i < 3; i++) {
		if (a[i]! !== b[i]!) return a[i]! > b[i]!;
	}
	return true; // equal
}

/**
 * Return the indented sub-block beneath a `key:` line that opens a mapping —
 * the run of lines more indented than the key itself, up to the next sibling
 * key or a dedent. Lets a test scope its assertions to one mapping (e.g.
 * `hooks.bootstrap`) instead of scanning the whole file, so a stray `script:`
 * or `fingerprint:` elsewhere can't produce a false pass. Returns "" if the
 * key isn't found as a block-opener.
 */
function blockUnder(yaml: string, key: string): string {
	const lines = yaml.split(/\r?\n/);
	const opener = new RegExp(`^(\\s*)${key}:\\s*$`);
	let start = -1;
	let indent = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line === undefined) continue;
		const m = opener.exec(line);
		if (m) {
			start = i;
			indent = (m[1] ?? "").length;
			break;
		}
	}
	if (start === -1) return "";

	const out: string[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line === undefined) break;
		if (line.trim() === "") {
			out.push(line); // blank lines stay inside the block
			continue;
		}
		const lineIndent = (line.match(/^\s*/)?.[0] ?? "").length;
		if (lineIndent <= indent) break; // sibling key or dedent → block ended
		out.push(line);
	}
	return out.join("\n");
}

describe("shard.yaml — hook lifecycle contract (#75)", () => {
	test("declares the three native lifecycle slots", () => {
		assert.match(shardYaml, /^hooks:/m, "missing hooks block");
		assert.match(shardYaml, /^\s+bootstrap:/m, "missing bootstrap slot");
		assert.match(shardYaml, /^\s+personalize:\s*\S/m, "missing personalize slot");
		assert.match(shardYaml, /^\s+post-update:\s*\S/m, "missing post-update slot");
	});

	test("bootstrap declares a script and a fingerprint", () => {
		// Scope to the hooks.bootstrap block so the assertions can't be
		// satisfied by a `script:`/`fingerprint:` key elsewhere in the file.
		const bootstrap = blockUnder(shardYaml, "bootstrap");
		assert.ok(bootstrap, "missing hooks.bootstrap block");
		assert.match(
			bootstrap,
			/^\s+script:\s*\.shardmind\/hooks\/bootstrap\.ts\s*$/m,
			"bootstrap.script must point at .shardmind/hooks/bootstrap.ts",
		);
		assert.match(
			bootstrap,
			/^\s+fingerprint:\s*"[^"]+"\s*$/m,
			"bootstrap.fingerprint must be set (re-bootstrap-on-update marker)",
		);
	});

	test("does NOT declare the deprecated post-install slot", () => {
		// A >=0.1.3 engine maps post-install -> bootstrap+personalize for
		// back-compat; declaring it alongside the native slots would dual-fire.
		assert.doesNotMatch(
			shardYaml,
			/^\s*post-install:/m,
			"post-install must not coexist with the native slots (dual-fire risk)",
		);
	});

	test(`requires.shardmind floor is >= ${MIN_SHARDMIND.join(".")}`, () => {
		const m = /^\s*shardmind:\s*">=(\d+)\.(\d+)\.(\d+)"/m.exec(shardYaml);
		assert.ok(
			m,
			'requires.shardmind must declare a ">=X.Y.Z" range so old engines refuse the install',
		);
		const floor: [number, number, number] = [
			Number(m![1]),
			Number(m![2]),
			Number(m![3]),
		];
		assert.ok(
			gte(floor, MIN_SHARDMIND),
			`requires.shardmind floor ${floor.join(".")} is below the ${MIN_SHARDMIND.join(
				".",
			)} the split hook lifecycle needs`,
		);
	});
});
