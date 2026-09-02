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

	test("a shape it cannot edit is refused, never appended to", () => {
		// The corruption this guards is the expensive one: appending a second
		// top-level `models:` makes the file unparseable, and qmd rethrows that
		// as a config error that takes every collection and all search with it.
		const r = upsertEmbedModelInYaml(
			`collections:\n  v:\n    path: /x\nmodels: {embed: ${QMD_DEFAULT_EMBED_MODEL}}\n`,
			PREFERRED_EMBED_MODEL,
		);
		assert.equal(r.kind, "unsupported");
	});

	test("no edit ever produces a duplicate key", () => {
		// One assertion over every spelling that reached the append branch before:
		// CRLF from a Windows host, a trailing space, a commented header, and an
		// `embed:` key with no value. Each one used to yield two `models:` keys
		// or two `embed:` keys.
		const D = QMD_DEFAULT_EMBED_MODEL;
		for (const [label, input] of [
			["CRLF", `collections:\r\n  v:\r\n    path: /x\r\nmodels:\r\n  embed: ${D}\r\n`],
			["trailing space", `collections:\n  v:\n    path: /x\nmodels: \n  embed: ${D}\n`],
			["commented header", `collections:\n  v:\n    path: /x\nmodels: # embedders\n  embed: ${D}\n`],
			["empty value", `collections:\n  v:\n    path: /x\nmodels:\n  embed:\n  rerank: hf:r\n`],
		] as const) {
			const r = upsertEmbedModelInYaml(input, PREFERRED_EMBED_MODEL);
			assert.equal(r.kind, "updated", label);
			if (r.kind !== "updated") continue;
			assert.equal((r.content.match(/^models:/gm) ?? []).length, 1, label);
			assert.equal((r.content.match(/^[ \t]+embed:/gm) ?? []).length, 1, label);
			assert.ok(r.content.includes(`embed: ${PREFERRED_EMBED_MODEL}`), label);
		}
	});

	test("a CRLF file stays CRLF", () => {
		// Rewriting a Windows config as LF would show up as every line changed in
		// whatever the user diffs it with.
		const r = upsertEmbedModelInYaml(
			`collections:\r\n  v:\r\n    path: /x\r\nmodels:\r\n  embed: ${QMD_DEFAULT_EMBED_MODEL}\r\n`,
			PREFERRED_EMBED_MODEL,
		);
		assert.equal(r.kind, "updated");
		assert.ok(r.kind === "updated" && r.content.includes("\r\n"));
		assert.ok(r.kind === "updated" && !/[^\r]\n/.test(r.content));
	});

	test("qmd's default is recognised through quotes and comments", () => {
		// Otherwise the decoration reads as a deliberate choice, the vault keeps
		// the worse embedder, and the warning tells the user their model is
		// neither qmd's default nor ours — when it is exactly qmd's default.
		for (const spelling of [
			`"${QMD_DEFAULT_EMBED_MODEL}"`,
			`'${QMD_DEFAULT_EMBED_MODEL}'`,
			`${QMD_DEFAULT_EMBED_MODEL} # qmd's default`,
		]) {
			const r = upsertEmbedModelInYaml(
				`collections:\n  v:\n    path: /x\nmodels:\n  embed: ${spelling}\n`,
				PREFERRED_EMBED_MODEL,
			);
			assert.equal(r.kind, "updated", spelling);
		}
	});

	test("an embed key with no value is unset, not chosen", () => {
		const r = upsertEmbedModelInYaml(
			`collections:\n  v:\n    path: /x\nmodels:\n  embed:\n  rerank: hf:r\n`,
			PREFERRED_EMBED_MODEL,
		);
		assert.equal(r.kind, "updated");
		assert.ok(r.kind === "updated" && r.content.includes("rerank: hf:r"));
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

	test("an unsupported config is left untouched on disk", () => {
		const dir = mkdtempSync(join(tmpdir(), "qmd-models-"));
		try {
			const p = join(dir, "vault.yml");
			const before = `collections:\n  v:\n    path: /x\nmodels: {embed: ${QMD_DEFAULT_EMBED_MODEL}}\n`;
			writeFileSync(p, before, "utf-8");
			assert.equal(writeQmdEmbedModel(p), false);
			assert.equal(readFileSync(p, "utf-8"), before);
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
