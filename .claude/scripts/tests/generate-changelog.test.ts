/**
 * Unit tests for the pure functions in .github/scripts/generate-changelog.ts —
 * commit classification, section generation, version normalization. The file-
 * system mutations and git invocations are exercised separately by the
 * release workflow on dry-run tags; these tests lock the parsing logic.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	classifyCommit,
	generateSection,
	normalizeVersion,
	toFingerprintKey,
	pickMarkers,
	findLatestOpenFingerprint,
} from "../../../.github/scripts/generate-changelog.ts";

describe("classifyCommit", () => {
	test("feat: → Added", () => {
		const r = classifyCommit("feat: add new hook");
		assert.equal(r.category, "Added");
		assert.equal(r.description, "add new hook");
	});

	test("fix: → Fixed", () => {
		const r = classifyCommit("fix: crash on empty input");
		assert.equal(r.category, "Fixed");
		assert.equal(r.description, "crash on empty input");
	});

	test("revert: → Fixed", () => {
		const r = classifyCommit("revert: broken migration");
		assert.equal(r.category, "Fixed");
	});

	test("docs: / refactor: / perf: / chore: / build: / style: → Changed", () => {
		for (const prefix of ["docs", "refactor", "perf", "chore", "build", "style"]) {
			const r = classifyCommit(`${prefix}: update something`);
			assert.equal(r.category, "Changed", `${prefix} should map to Changed`);
		}
	});

	test("ci: / test: / release: → null (skipped)", () => {
		for (const prefix of ["ci", "test", "release"]) {
			const r = classifyCommit(`${prefix}: noisy change`);
			assert.equal(r.category, null, `${prefix} should be skipped`);
		}
	});

	test("scoped prefix — feat(hooks): → Added", () => {
		const r = classifyCommit("feat(hooks): add stop-checklist");
		assert.equal(r.category, "Added");
		assert.equal(r.description, "add stop-checklist");
	});

	test("strips PR reference suffix (#25)", () => {
		const r = classifyCommit("feat: add thing (#25)");
		assert.equal(r.description, "add thing");
	});

	test("no prefix — capitalizes and goes to Changed", () => {
		const r = classifyCommit("some freeform commit");
		assert.equal(r.category, "Changed");
		assert.equal(r.description, "Some freeform commit");
	});

	test("unknown prefix falls through to Changed", () => {
		const r = classifyCommit("wizardry: mysterious change");
		assert.equal(r.category, "Changed");
	});
});

describe("generateSection", () => {
	test("groups commits by category in SECTION_ORDER", () => {
		const out = generateSection("v5.0", [
			"feat: add A",
			"fix: fix B",
			"docs: update C",
			"feat: add D",
		]);
		// Added section precedes Changed precedes Fixed per SECTION_ORDER
		const addedIdx = out.indexOf("### Added");
		const changedIdx = out.indexOf("### Changed");
		const fixedIdx = out.indexOf("### Fixed");
		assert.ok(addedIdx >= 0 && changedIdx >= 0 && fixedIdx >= 0);
		assert.ok(addedIdx < changedIdx);
		assert.ok(changedIdx < fixedIdx);
		assert.match(out, /- add A\n/);
		assert.match(out, /- add D\n/);
		assert.match(out, /- fix B\n/);
		assert.match(out, /- update C\n/);
	});

	test("skipped categories are not emitted", () => {
		const out = generateSection("v5.0", ["ci: flake fix", "test: coverage"]);
		assert.doesNotMatch(out, /### Added/);
		assert.doesNotMatch(out, /### Changed/);
		assert.doesNotMatch(out, /### Fixed/);
	});

	test("header carries the version", () => {
		const out = generateSection("v5.0", ["feat: add thing"]);
		assert.match(out, /^## v5\.0 — \d{4}-\d{2}-\d{2}/);
	});
});

describe("normalizeVersion", () => {
	// release.yml normalizes bare 'v5' → 'v5.0' before invoking this script,
	// so the input shape is always vX.Y or vX.Y.Z by contract.
	test("v5.2 → 5.2.0", () => {
		assert.equal(normalizeVersion("v5.2"), "5.2.0");
	});
	test("v5.2.3 → 5.2.3", () => {
		assert.equal(normalizeVersion("v5.2.3"), "5.2.3");
	});
	test("5.2 (no v) → 5.2.0", () => {
		assert.equal(normalizeVersion("5.2"), "5.2.0");
	});
	test("5.2.3 (no v) → 5.2.3", () => {
		assert.equal(normalizeVersion("5.2.3"), "5.2.3");
	});
});

describe("toFingerprintKey", () => {
	test("drops .0 patch for minor releases", () => {
		assert.equal(toFingerprintKey("5.0.0"), "v5.0");
		assert.equal(toFingerprintKey("v5.0"), "v5.0");
		assert.equal(toFingerprintKey("5.0"), "v5.0");
	});
	test("preserves non-zero patch", () => {
		assert.equal(toFingerprintKey("5.1.2"), "v5.1.2");
		assert.equal(toFingerprintKey("v3.4.1"), "v3.4.1");
	});
	test("double-digit components survive", () => {
		assert.equal(toFingerprintKey("10.12.0"), "v10.12");
	});
});

describe("pickMarkers", () => {
	const GLOBS = [
		"CLAUDE.md",
		"AGENTS.md",
		".mcp.json",
		".claude/**",
		".codex/**",
		".github/scripts/generate-changelog.ts",
		"templates/**",
	];

	test("returns at most `limit` entries (default 3)", () => {
		const added = [
			"AGENTS.md",
			".codex/hooks.json",
			".mcp.json",
			"templates/New.md",
			".claude/commands/new.md",
		];
		const picked = pickMarkers(added, GLOBS);
		assert.equal(picked.length, 3);
	});

	test("filters out files not covered by infrastructure globs", () => {
		const added = ["work/active/project.md", "brain/MyGotchas.md", ".mcp.json"];
		assert.deepEqual(pickMarkers(added, GLOBS), [".mcp.json"]);
	});

	test("skips tests/, lib/, node_modules/, and .github/", () => {
		const added = [
			".claude/scripts/tests/new.test.ts",
			".claude/scripts/lib/internal.ts",
			".claude/scripts/node_modules/whatever.js",
			".github/workflows/new.yml",
			".mcp.json",
		];
		assert.deepEqual(pickMarkers(added, GLOBS), [".mcp.json"]);
	});

	test("skips .test.ts files even outside a tests/ dir", () => {
		const added = [".claude/scripts/manifest-check.test.ts", ".mcp.json"];
		assert.deepEqual(pickMarkers(added, GLOBS), [".mcp.json"]);
	});

	test("custom limit is respected", () => {
		const added = ["AGENTS.md", ".mcp.json", ".codex/hooks.json"];
		assert.equal(pickMarkers(added, GLOBS, 2).length, 2);
	});

	test("returns empty when nothing qualifies", () => {
		assert.deepEqual(pickMarkers(["work/foo.md", "README.ja.md"], GLOBS), []);
	});

	test("prefers shallow (root-level) paths over deep subdirectory paths", () => {
		// Regression test for the original heuristic, which walked alphabetically
		// and picked .claude/scripts/* over .mcp.json. Root-level files are
		// more meaningful markers; they should rank first.
		const added = [
			".claude/scripts/charcount.ts",
			".claude/scripts/classify-message.ts",
			".claude/scripts/package.json",
			".mcp.json",
		];
		const picked = pickMarkers(added, GLOBS);
		assert.equal(picked[0], ".mcp.json", "root-level .mcp.json should rank first");
	});

	test("prefers singletons in their parent dir over bulk-added siblings", () => {
		// At the same depth, a file with fewer siblings-in-this-diff is a
		// more distinctive marker. `a/rare.md` is alone under `a/`; `b/` has
		// three files, so b's entries rank after a's.
		const globs = ["**"];
		const added = [
			"b/mass1.md",
			"b/mass2.md",
			"b/mass3.md",
			"a/rare.md",
		];
		const picked = pickMarkers(added, globs, 1);
		assert.deepEqual(picked, ["a/rare.md"]);
	});

	test("falls back to alphabetical order when depth and sibling count tie", () => {
		const globs = ["*.md"];
		const added = ["zebra.md", "alpha.md", "mango.md"];
		assert.deepEqual(pickMarkers(added, globs), [
			"alpha.md",
			"mango.md",
			"zebra.md",
		]);
	});
});

describe("findLatestOpenFingerprint", () => {
	test("returns the highest version without a missing field", () => {
		const fp = {
			"v3.7": { exists: ["x"], missing: ["y"] },
			"v4.0": { exists: ["a"] },
		};
		assert.equal(findLatestOpenFingerprint(fp), "v4.0");
	});

	test("uses numeric component sort (v3.10 > v3.7)", () => {
		const fp = {
			"v3.7": { exists: ["a"] },
			"v3.10": { exists: ["b"] },
		};
		assert.equal(findLatestOpenFingerprint(fp), "v3.10");
	});

	test("returns null when every entry is closed", () => {
		const fp = {
			"v3.7": { exists: ["a"], missing: ["b"] },
			"v4.0": { exists: ["c"], missing: ["d"] },
		};
		assert.equal(findLatestOpenFingerprint(fp), null);
	});

	test("returns null when empty", () => {
		assert.equal(findLatestOpenFingerprint({}), null);
	});

	test("single open entry is returned regardless of version", () => {
		const fp = { v1: { exists: ["a"] } };
		assert.equal(findLatestOpenFingerprint(fp), "v1");
	});

	test("mixed three-part + two-part versions sort correctly", () => {
		const fp = {
			"v3.6.0": { exists: ["a"] },
			"v3.6": { exists: ["b"] }, // equivalent to v3.6.0 numerically
			"v3.7": { exists: ["c"] },
		};
		assert.equal(findLatestOpenFingerprint(fp), "v3.7");
	});
});
