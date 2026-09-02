/**
 * Unit tests for lib/qmd-models — choosing the embedding model.
 *
 * The policy is the whole point and it is three-way: replace qmd's default,
 * keep a deliberate choice, do nothing when it is already right. Getting the
 * middle case wrong would silently overwrite a user's setting on every
 * bootstrap, and getting the last one wrong would force a full re-embed every
 * run, so both are locked here.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	PREFERRED_EMBED_MODEL,
	QMD_DEFAULT_EMBED_MODEL,
	upsertEmbedModelInYaml,
	writeQmdEmbedModel,
} from "../lib/qmd-models.ts";

import { rmTemp } from "./_helpers.ts";

const CONFIG = (embed: string) =>
	`collections:\n  vault:\n    path: /somewhere\n    pattern: "**/*.md"\nmodels:\n  embed: ${embed}\n  generate: hf:some/generate.gguf\n  rerank: hf:some/rerank.gguf\n`;

describe("choosing the embedding model", () => {
	test("qmd's default is replaced", () => {
		const r = upsertEmbedModelInYaml(CONFIG(QMD_DEFAULT_EMBED_MODEL), PREFERRED_EMBED_MODEL);
		assert.equal(r.kind, "updated");
		assert.ok(r.kind === "updated" && r.content.includes(`embed: ${PREFERRED_EMBED_MODEL}`));
	});

	test("a model somebody chose is never overwritten", () => {
		// A template supplies a better default. It does not overrule a choice —
		// and on every bootstrap run, which is what makes this the dangerous one.
		const mine = "hf:someone/their-own-embedder.gguf";
		const r = upsertEmbedModelInYaml(CONFIG(mine), PREFERRED_EMBED_MODEL);
		assert.equal(r.kind, "user-chosen");
		assert.equal(r.kind === "user-chosen" && r.current, mine);
	});

	test("already correct is not a change", () => {
		// A write here would be harmless but the caller reads this as "the model
		// changed" and forces a full re-embed, so it must not report one.
		assert.equal(
			upsertEmbedModelInYaml(CONFIG(PREFERRED_EMBED_MODEL), PREFERRED_EMBED_MODEL).kind,
			"already-set",
		);
	});

	test("everything else in the file survives the edit", () => {
		// The config also carries the collection, its glob, ignore patterns and
		// the context string. Losing any of them would be a far worse bug than
		// the one being fixed.
		const before =
			`collections:\n  vault:\n    path: /somewhere\n    pattern: "**/*.md"\n    ignore:\n      - "drafts/**"\n    context:\n      "": A description of the vault.\nmodels:\n  embed: ${QMD_DEFAULT_EMBED_MODEL}\n  generate: hf:some/generate.gguf\n`;
		const r = upsertEmbedModelInYaml(before, PREFERRED_EMBED_MODEL);
		assert.equal(r.kind, "updated");
		if (r.kind !== "updated") return;
		for (const kept of [
			"path: /somewhere",
			'pattern: "**/*.md"',
			'- "drafts/**"',
			'"": A description of the vault.',
			"generate: hf:some/generate.gguf",
		]) {
			assert.ok(r.content.includes(kept), kept);
		}
	});

	test("a config with no models block gets one", () => {
		const r = upsertEmbedModelInYaml(`collections:\n  vault:\n    path: /somewhere\n`, PREFERRED_EMBED_MODEL);
		assert.equal(r.kind, "updated");
		assert.ok(r.kind === "updated" && r.content.includes(`models:\n  embed: ${PREFERRED_EMBED_MODEL}`));
	});

	test("a models block without an embed key gets one, keeping its siblings", () => {
		const r = upsertEmbedModelInYaml(`collections:\n  vault:\n    path: /x\nmodels:\n  rerank: hf:some/rerank.gguf\n`, PREFERRED_EMBED_MODEL);
		assert.equal(r.kind, "updated");
		assert.ok(r.kind === "updated" && r.content.includes(`embed: ${PREFERRED_EMBED_MODEL}`));
		assert.ok(r.kind === "updated" && r.content.includes("rerank: hf:some/rerank.gguf"));
	});

	test("the result is valid input to itself", () => {
		// Bootstrap is documented as safe to re-run, so a second pass over its
		// own output must report no change rather than churn the file.
		const first = upsertEmbedModelInYaml(CONFIG(QMD_DEFAULT_EMBED_MODEL), PREFERRED_EMBED_MODEL);
		assert.equal(first.kind, "updated");
		if (first.kind !== "updated") return;
		assert.equal(upsertEmbedModelInYaml(first.content, PREFERRED_EMBED_MODEL).kind, "already-set");
	});
});

describe("writing the embedding model to disk", () => {
	test("a changed file reports true, an unchanged one false", () => {
		const dir = mkdtempSync(join(tmpdir(), "qmd-models-"));
		try {
			const p = join(dir, "vault.yml");
			writeFileSync(p, CONFIG(QMD_DEFAULT_EMBED_MODEL), "utf-8");
			// True is what makes the caller force a re-embed; the two must agree.
			assert.equal(writeQmdEmbedModel(p), true);
			assert.ok(readFileSync(p, "utf-8").includes(`embed: ${PREFERRED_EMBED_MODEL}`));
			assert.equal(writeQmdEmbedModel(p), false);
		} finally {
			rmTemp(dir);
		}
	});

	test("a missing config is not an error", () => {
		// qmd creates it on first use. A fresh clone reaching here early should
		// warn and carry on, not abort the bootstrap.
		const dir = mkdtempSync(join(tmpdir(), "qmd-models-"));
		try {
			assert.equal(writeQmdEmbedModel(join(dir, "nope.yml")), false);
		} finally {
			rmTemp(dir);
		}
	});
});
