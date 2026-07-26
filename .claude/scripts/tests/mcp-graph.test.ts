/**
 * Graph traversal.
 *
 * The tests that matter are the ones about what `expand` REFUSES to say. A
 * backlink query is a listing query wearing a different hat: "what links to X"
 * discloses the existence and the titles of the notes doing the linking, so a
 * graph walk over unfenced files hands back exactly what the fence withheld.
 *
 * The other half is the resolution key. It exists because of a measured
 * failure — search returned index paths, the model fed them into a read that
 * only accepted URIs, and both surfaces failed — so it is tested against every
 * form a caller might realistically produce.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { normalizeKey, resolveVisible, outboundLinks, expandNote } from "../lib/mcp-graph.ts";
import { resolveExposure, visibleFiles, type VisibleFile } from "../lib/mcp-exposure.ts";

function put(dir: string, rel: string, body: string): void {
	const full = join(dir, rel);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, body, "utf8");
}

function note(desc: string, body = ""): string {
	return `---\ndate: 2026-07-26\ndescription: "${desc}"\n---\n\n# n\n\n${body}\n`;
}

function withVault(fn: (dir: string, files: VisibleFile[]) => void, roots = ["brain", "reference"]): void {
	const dir = mkdtempSync(join(tmpdir(), "graph-"));
	try {
		// A small graph: Gotchas <-> Patterns, both linking to a note in work/,
		// which is OUTSIDE the fence. work/ also links back to Gotchas.
		put(dir, "brain/Gotchas.md", note("things that bit us", "See [[Patterns]] and [[TR Comp]]."));
		put(dir, "brain/Patterns.md", note("how we do things", "Related: [[Gotchas]]."));
		put(dir, "brain/Key Decisions.md", note("choices", "Nothing links here."));
		put(dir, "reference/Arch.md", note("architecture", "Builds on [[Patterns]]."));
		put(dir, "work/TR Comp.md", note("confidential", "Contradicts [[Gotchas]]."));
		const policy = resolveExposure(dir, { mcp_exposed_roots: roots });
		fn(dir, visibleFiles(dir, policy));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Reference resolution
// ---------------------------------------------------------------------------

describe("normalising a reference", () => {
	test("every form a caller might produce collapses to one key", () => {
		// This is the compose bug: search speaks index paths, resources speak
		// URIs, and a human speaks the title. All three must land on one note.
		const forms = [
			"Key Decisions",
			"key decisions",
			"Key-Decisions",
			"Key_Decisions",
			"brain/Key Decisions.md",
			"myvault/brain/Key-Decisions.md",
			"vault://note/brain/Key%20Decisions.md",
			"vault://brain/Key%20Decisions.md",
			"C:\\Dev\\v\\brain\\Key Decisions.md",
		];
		const keys = new Set(forms.map(normalizeKey));
		assert.equal(keys.size, 1, `expected one key, got ${[...keys].join(" | ")}`);
		assert.equal([...keys][0], "keydecisions");
	});

	test("a malformed percent escape does not throw the lookup away", () => {
		assert.equal(normalizeKey("brain/100%.md"), "100%");
	});

	test("empty input is an empty key rather than a match-anything", () => {
		assert.equal(normalizeKey(""), "");
		assert.equal(normalizeKey(null), "");
	});

	test("resolves a visible note from any form", () => {
		withVault((_dir, files) => {
			for (const form of ["Gotchas", "brain/Gotchas.md", "vault://note/brain/Gotchas.md", "GOTCHAS"]) {
				assert.equal(resolveVisible(files, form)?.label, "Gotchas", `resolved ${form}`);
			}
		});
	});

	test("an out-of-scope note does not resolve, however it is named", () => {
		withVault((_dir, files) => {
			for (const form of ["TR Comp", "work/TR Comp.md", "vault://note/work/TR Comp.md"]) {
				assert.equal(resolveVisible(files, form), null, `refused ${form}`);
			}
		});
	});

	test("an ambiguous reference returns null rather than guessing", () => {
		// Picking one silently hands back the wrong note's content with no signal.
		const files: VisibleFile[] = [
			{ full: "/v/a/Notes.md", label: "Notes", scope: "a" },
			{ full: "/v/b/Notes.md", label: "Notes", scope: "b" },
		];
		assert.equal(resolveVisible(files, "Notes"), null);
	});
});

// ---------------------------------------------------------------------------
// Link extraction
// ---------------------------------------------------------------------------

describe("extracting links", () => {
	test("plain, aliased and heading links all yield the target", () => {
		assert.deepEqual(outboundLinks("[[A]] [[B|shown as]] [[C#section]]"), ["A", "B", "C"]);
	});

	test("duplicates collapse, case-insensitively, keeping first-seen order", () => {
		assert.deepEqual(outboundLinks("[[A]] [[b]] [[a]] [[B]]"), ["A", "b"]);
	});

	test("empty and malformed links are ignored", () => {
		assert.deepEqual(outboundLinks("[[]] [[ ]] [not a link] [[ok]]"), ["ok"]);
	});

	test("no links is an empty list, not a throw", () => {
		assert.deepEqual(outboundLinks("nothing here"), []);
	});
});

// ---------------------------------------------------------------------------
// Expansion, and what it refuses to disclose
// ---------------------------------------------------------------------------

describe("expanding a note", () => {
	test("returns links out and links back", () => {
		withVault((_dir, files) => {
			const r = expandNote(files, "Patterns");
			assert.equal(r.note?.label, "Patterns");
			assert.deepEqual(r.outbound, ["Gotchas"]);
			// Both Gotchas and Arch link to Patterns.
			assert.deepEqual(r.inbound.sort(), ["Arch", "Gotchas"]);
		});
	});

	test("an outbound link outside the fence is COUNTED but never NAMED", () => {
		withVault((_dir, files) => {
			const r = expandNote(files, "Gotchas");
			assert.equal(r.hiddenOutbound, 1, "the link to work/ must be counted");
			assert.ok(!r.text.includes("TR Comp"), "and must not be named");
			assert.match(r.text, /1 outside your scope/);
		});
	});

	test("a backlink from outside the fence is not disclosed at all", () => {
		// work/TR Comp.md links to Gotchas. Reporting it would tell the caller a
		// note it may not read exists, and what it is called.
		withVault((_dir, files) => {
			const r = expandNote(files, "Gotchas");
			assert.ok(!r.inbound.includes("TR Comp"));
			assert.ok(!r.text.includes("TR Comp"));
		});
	});

	test("an unknown seed suggests only visible notes", () => {
		withVault((_dir, files) => {
			const r = expandNote(files, "Gotch");
			assert.equal(r.note, null);
			assert.match(r.text, /No visible note matches/);
			assert.match(r.text, /Gotchas/);
		});
	});

	test("a seed naming a withheld note does not confirm it exists", () => {
		withVault((_dir, files) => {
			const r = expandNote(files, "TR Comp");
			assert.equal(r.note, null);
			// The near-miss list is built from visible files only, so it cannot
			// echo the withheld title back as a suggestion.
			assert.ok(!r.text.includes("Did you mean: TR Comp"));
		});
	});

	test("a note with no neighbours reads as empty rather than broken", () => {
		withVault((_dir, files) => {
			const r = expandNote(files, "Key Decisions");
			assert.deepEqual(r.inbound, []);
			assert.match(r.text, /Links out \(0 visible\)/);
			assert.match(r.text, /- \(none visible\)/);
		});
	});

	test("the header carries the scope and the description", () => {
		withVault((_dir, files) => {
			const r = expandNote(files, "Arch");
			assert.match(r.text, /# Arch {2}\(reference\)/);
			assert.match(r.text, /architecture/);
		});
	});

	test("a seed given as a path or a URI expands the same note", () => {
		withVault((_dir, files) => {
			const byTitle = expandNote(files, "Patterns");
			for (const form of ["brain/Patterns.md", "vault://note/brain/Patterns.md", "myvault/brain/Patterns.md"]) {
				assert.equal(expandNote(files, form).note?.full, byTitle.note?.full, `matched via ${form}`);
			}
		});
	});

	test("an empty seed does not match an arbitrary note", () => {
		withVault((_dir, files) => {
			assert.equal(expandNote(files, "").note, null);
		});
	});

	test("widening the fence reveals what was previously only a count", () => {
		// The same query, the same graph, a different policy: proof the hiding is
		// the fence's doing and not a parsing failure.
		withVault(
			(_dir, files) => {
				const r = expandNote(files, "Gotchas");
				assert.equal(r.hiddenOutbound, 0);
				assert.ok(r.outbound.includes("TR Comp"));
			},
			["brain", "reference", "work"],
		);
	});
});
