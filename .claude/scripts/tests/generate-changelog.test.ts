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
