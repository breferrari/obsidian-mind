/**
 * Promoted-marker GATE (#246): every anchored `promoted:` marker in this
 * vault's memory store must resolve to exactly one block.
 *
 * Splitting a note is the prescribed fix for an oversized one, and it orphans
 * every marker pointing into the note: the markers live in `memories/`, out of
 * view of the split. Recall then serves the capture as first written instead
 * of the corrected block, and nothing errors. A zero gate, in the shape of
 * `vault-wikilinks.test.ts`, makes that state impossible to walk past.
 *
 * The first block runs on the REAL vault. A vault with no captures (the
 * template) skips it, saying why; a vault whose memory folder holds notes the
 * reader parsed none of fails rather than passing on an empty walk. The rest
 * pin the rules on fixtures.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseMemoryRoot } from "../lib/active-hygiene.ts";
import { checkPromotedMarkers, countAnchorDefinitions } from "../lib/promoted-gate.ts";
import { rmTemp } from "./_helpers.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function manifestJson(): string | null {
	try {
		return readFileSync(join(repoRoot, "vault-manifest.json"), "utf8");
	} catch {
		return null;
	}
}

describe("promoted markers — this vault", () => {
	const memoryRoot = parseMemoryRoot(manifestJson());
	const result = checkPromotedMarkers(repoRoot, memoryRoot);
	const noCaptures = result.files === 0 ? `no captures in ${memoryRoot}/ — nothing to check` : false;

	test("the walk read the store it was given", { skip: noCaptures }, () => {
		assert.ok(
			result.captures > 0,
			`${memoryRoot}/ holds ${result.files} notes and the reader parsed none — a gate on an empty walk proves nothing`,
		);
	});

	test("every anchored marker resolves to exactly one block", { skip: noCaptures }, () => {
		assert.deepEqual(
			result.failures,
			[],
			`${result.failures.length} promoted marker(s) do not resolve. After a split, point each at the block's new note:\n  ${result.failures.join("\n  ")}`,
		);
	});
});

describe("promoted markers — the rules", () => {
	function vault(notes: Record<string, string>): string {
		const dir = mkdtempSync(join(tmpdir(), "promoted-gate-"));
		for (const [rel, body] of Object.entries(notes)) {
			mkdirSync(dirname(join(dir, rel)), { recursive: true });
			writeFileSync(join(dir, rel), body);
		}
		return dir;
	}
	const capture = (marker: string) => `---\ntitle: A lesson\npromoted: "${marker}"\n---\nThe lesson as first written.\n`;

	test("a marker whose block is in the named note passes", () => {
		const dir = vault({
			"memories/2026/09/a.md": capture("brain/Gotchas#^om-a1"),
			"brain/Gotchas.md": "# Gotchas\n\nThe corrected lesson. ^om-a1\n",
		});
		try {
			const r = checkPromotedMarkers(dir, "memories");
			assert.deepEqual(r.failures, []);
			assert.equal(r.anchored, 1);
		} finally {
			rmTemp(dir);
		}
	});

	test("after a split moved the block, the marker fails and names the capture", () => {
		const dir = vault({
			"memories/2026/09/a.md": capture("brain/Gotchas#^om-a1"),
			"brain/Gotchas.md": "# Gotchas\n\n- moved to [[Gotchas - Tooling]]\n",
			"brain/Gotchas - Tooling.md": "# Tooling\n\nThe corrected lesson. ^om-a1\n",
		});
		try {
			const r = checkPromotedMarkers(dir, "memories");
			assert.equal(r.failures.length, 1);
			assert.match(r.failures[0]!, /2026\/09\/a\.md: promoted into brain\/Gotchas.* anchor is not in that note/);
		} finally {
			rmTemp(dir);
		}
	});

	test("a marker into a note that no longer exists fails", () => {
		const dir = vault({ "memories/2026/09/a.md": capture("brain/Gone#^om-a1"), "brain/Other.md": "x\n" });
		try {
			assert.equal(checkPromotedMarkers(dir, "memories").failures.length, 1);
		} finally {
			rmTemp(dir);
		}
	});

	test("an anchor defined twice in its note fails", () => {
		const dir = vault({
			"memories/2026/09/a.md": capture("brain/Gotchas#^om-a1"),
			"brain/Gotchas.md": "# G\n\nFirst. ^om-a1\n\nSecond. ^om-a1\n",
		});
		try {
			const [f] = checkPromotedMarkers(dir, "memories").failures;
			assert.match(f ?? "", /\^om-a1 is defined 2 times/);
		} finally {
			rmTemp(dir);
		}
	});

	test("references to the block, and a longer anchor sharing its prefix, are not definitions", () => {
		const body = "Block. ^om-fix\n\nSee [[#^om-fix]] and [[Gotchas#^om-fix]].\n\nOther. ^om-fix-escape\n";
		assert.equal(countAnchorDefinitions(body, "om-fix"), 1);
		assert.equal(countAnchorDefinitions(body, "om-fix-escape"), 1);
	});

	test("a bare marker (no anchor) is a reported state, not a failure", () => {
		const dir = vault({ "memories/2026/09/a.md": capture("brain/Gotchas"), "brain/Gotchas.md": "x\n" });
		try {
			const r = checkPromotedMarkers(dir, "memories");
			assert.deepEqual(r.failures, []);
			assert.equal(r.anchored, 0);
		} finally {
			rmTemp(dir);
		}
	});

	test("an unparseable marker fails, naming the capture", () => {
		// A control character makes the marker unparseable (parsePromotedMarker
		// refuses it): the frontmatter says promoted, every consumer sees nothing.
		const dir = vault({ "memories/2026/09/a.md": "---\ntitle: A\npromoted: \"brain/Gotchas#^om\u0007a1\"\n---\nbody\n", "brain/Gotchas.md": "x\n" });
		try {
			const [f] = checkPromotedMarkers(dir, "memories").failures;
			assert.match(f ?? "", /a\.md: promoted: marker cannot be parsed/);
		} finally {
			rmTemp(dir);
		}
	});

	test("files and captures are counted apart, so an empty walk over a full folder is visible", () => {
		const dir = vault({ "memories/2026/09/a.md": capture("brain/Gotchas#^om-a1"), "brain/Gotchas.md": "x ^om-a1\n" });
		try {
			const r = checkPromotedMarkers(dir, "memories");
			assert.equal(r.files, 1);
			assert.equal(r.captures, 1);
			assert.equal(checkPromotedMarkers(dir, "elsewhere").files, 0);
		} finally {
			rmTemp(dir);
		}
	});
});
