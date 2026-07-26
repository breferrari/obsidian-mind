/**
 * Graph traversal.
 *
 * The tests that matter are the ones about what `expand` leaves OUT. A backlink
 * query is a listing query wearing a different hat: "what links to X" reports
 * the titles of the notes doing the linking, so a graph walk over every file on
 * disk would answer with notes the other surfaces do not serve.
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
		// which the default roots do NOT serve. work/ also links back to Gotchas.
		put(dir, "brain/Gotchas.md", note("things that bit us", "See [[Patterns]] and [[Roadmap]]."));
		put(dir, "brain/Patterns.md", note("how we do things", "Related: [[Gotchas]]."));
		put(dir, "brain/Key Decisions.md", note("choices", "Nothing links here."));
		put(dir, "reference/Arch.md", note("architecture", "Builds on [[Patterns]]."));
		put(dir, "work/Roadmap.md", note("what is planned", "Contradicts [[Gotchas]]."));
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
			for (const form of ["Roadmap", "work/Roadmap.md", "vault://note/work/Roadmap.md"]) {
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

	test("an outbound link outside the served set is COUNTED but never NAMED", () => {
		withVault((_dir, files) => {
			const r = expandNote(files, "Gotchas");
			assert.equal(r.hiddenOutbound, 1, "the link to work/ must be counted");
			assert.ok(!r.text.includes("Roadmap"), "and must not be named");
			assert.match(r.text, /1 outside your scope/);
		});
	});

	test("a backlink from an unserved note is not reported at all", () => {
		// work/Roadmap.md links to Gotchas, but `expand` cannot follow the edge
		// back, so naming it would offer a neighbour the caller cannot open.
		withVault((_dir, files) => {
			const r = expandNote(files, "Gotchas");
			assert.ok(!r.inbound.includes("Roadmap"));
			assert.ok(!r.text.includes("Roadmap"));
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

	test("a seed naming an unserved note resolves to nothing", () => {
		withVault((_dir, files) => {
			const r = expandNote(files, "Roadmap");
			assert.equal(r.note, null);
			// The near-miss list is built from served files only, so it cannot
			// suggest a title `expand` would then refuse to open.
			assert.ok(!r.text.includes("Did you mean: Roadmap"));
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

	test("an ambiguous seed reports the collision instead of guessing", () => {
		// Regression: expandNote used `find`, so it returned the FIRST match and
		// handed back the wrong note's neighbourhood with no signal — the exact
		// behaviour resolveVisible refuses, broken by the module's primary path.
		const files: VisibleFile[] = [
			{ full: "/v/brain/Notes.md", label: "Notes", scope: "brain" },
			{ full: "/v/reference/Notes.md", label: "Notes", scope: "reference" },
		];
		const r = expandNote(files, "Notes");
		assert.equal(r.note, null, "must not pick one");
		assert.match(r.text, /matches 2 visible notes/);
		assert.match(r.text, /brain\/Notes/);
		assert.match(r.text, /reference\/Notes/);
		assert.match(r.text, /Pass a path/, "must say how to disambiguate");
	});

	test("a path disambiguates what a bare title cannot", () => {
		const files: VisibleFile[] = [
			{ full: "/v/brain/Notes.md", label: "Notes", scope: "brain" },
			{ full: "/v/reference/Notes.md", label: "Notes", scope: "reference" },
		];
		assert.equal(expandNote(files, "reference/Notes.md").note?.scope, "reference");
	});

	test("an empty seed does not match an arbitrary note", () => {
		withVault((_dir, files) => {
			assert.equal(expandNote(files, "").note, null);
		});
	});

	test("widening the roots reveals what was previously only a count", () => {
		// The same query, the same graph, a different policy: proof the omission
		// is the policy's doing and not a parsing failure.
		withVault(
			(_dir, files) => {
				const r = expandNote(files, "Gotchas");
				assert.equal(r.hiddenOutbound, 0);
				assert.ok(r.outbound.includes("Roadmap"));
			},
			["brain", "reference", "work"],
		);
	});
});
