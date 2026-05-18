/**
 * Locks the argv shape for `qmd collection add` and the benign-failure
 * matcher. qmd's CLI parses with `strict: false`, so a positional name or
 * `--pattern` flag are silently dropped — these tests catch any drift back
 * to that shape and any over-broad matcher that would swallow qmd's
 * path-collision warning.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
	buildCollectionAddArgs,
	makeCollectionAddBenignMatcher,
} from "../lib/qmd-bootstrap.ts";

describe("buildCollectionAddArgs", () => {
	test("emits the exact argv shape qmd's `collection add` expects", () => {
		const args = buildCollectionAddArgs("obsidian-mind", "obsidian-mind");
		assert.deepEqual(args, [
			"--index",
			"obsidian-mind",
			"collection",
			"add",
			".",
			"--name",
			"obsidian-mind",
			"--mask",
			"**/*.md",
		]);
	});

	test("places `--name` AFTER the `.` positional so qmd parses pwd as `.`", () => {
		// qmd's `collection add` dispatch reads cli.args[1] as the working
		// directory. If `--name` (or the name value) sat in that slot, qmd
		// would treat it as a path and either fail or auto-derive a bogus name.
		const args = buildCollectionAddArgs("idx", "vault-name");
		const addIdx = args.indexOf("add");
		assert.equal(args[addIdx + 1], ".", "positional after `add` must be `.`");
		assert.notEqual(
			args[addIdx + 2],
			"vault-name",
			"name must NOT sit in the next positional slot",
		);
	});

	test("`--name` immediately precedes the collection name value", () => {
		const args = buildCollectionAddArgs("idx", "my-vault");
		const nameIdx = args.indexOf("--name");
		assert.notEqual(nameIdx, -1, "`--name` flag must be present");
		assert.equal(args[nameIdx + 1], "my-vault");
	});

	test("`--mask` immediately precedes the glob value (NOT `--pattern`)", () => {
		// qmd reads cli.values.mask only; --pattern is silently swallowed under
		// parseArgs strict:false. Locking the flag name here so a well-meaning
		// rename can't re-introduce the silent-noop.
		const args = buildCollectionAddArgs("idx", "name");
		assert.equal(args.includes("--pattern"), false, "must not pass `--pattern`");
		const maskIdx = args.indexOf("--mask");
		assert.notEqual(maskIdx, -1, "`--mask` flag must be present");
		assert.equal(args[maskIdx + 1], "**/*.md");
	});

	test("propagates a custom glob through `--mask`", () => {
		const args = buildCollectionAddArgs("idx", "name", "journals/**/*.md");
		const maskIdx = args.indexOf("--mask");
		assert.equal(args[maskIdx + 1], "journals/**/*.md");
	});

	test("`--index` immediately precedes the index value at argv[0..1]", () => {
		const args = buildCollectionAddArgs("vault-a", "vault-a");
		assert.equal(args[0], "--index");
		assert.equal(args[1], "vault-a");
	});
});

describe("makeCollectionAddBenignMatcher", () => {
	test("matches qmd's by-name 'already exists' output on stderr", () => {
		const matches = makeCollectionAddBenignMatcher("obsidian-mind");
		assert.equal(
			matches({
				stdout: "",
				stderr: "Collection 'obsidian-mind' already exists.",
			}),
			true,
		);
	});

	test("matches the same output on stdout (qmd's stream choice varies)", () => {
		const matches = makeCollectionAddBenignMatcher("obsidian-mind");
		assert.equal(
			matches({
				stdout: "Collection 'obsidian-mind' already exists.",
				stderr: "",
			}),
			true,
		);
	});

	test("matches when the message appears on BOTH streams (split output)", () => {
		const matches = makeCollectionAddBenignMatcher("obsidian-mind");
		assert.equal(
			matches({
				stdout: "Collection 'obsidian-mind' already exists.",
				stderr: "Collection 'obsidian-mind' already exists.",
			}),
			true,
		);
	});

	test("matches double-quoted variant for output-format resilience", () => {
		const matches = makeCollectionAddBenignMatcher("obsidian-mind");
		assert.equal(
			matches({
				stdout: "",
				stderr: 'Collection "obsidian-mind" already exists.',
			}),
			true,
		);
	});

	test("matches unquoted variant", () => {
		const matches = makeCollectionAddBenignMatcher("obsidian-mind");
		assert.equal(
			matches({
				stdout: "",
				stderr: "Collection obsidian-mind already exists",
			}),
			true,
		);
	});

	test("does NOT swallow qmd's path-collision warning (stale-name upgrade case)", () => {
		// Real qmd output when a different-named collection points at the same
		// path+glob. Swallowing it leaves the stale collection in place and
		// `context add` then fails downstream.
		const matches = makeCollectionAddBenignMatcher("obsidian-mind");
		const stderr =
			"A collection already exists for this path and pattern:\n" +
			"  Name: C:\\Users\\foo\\my-vault\n" +
			"  Pattern: **/*.md\n" +
			"Use 'qmd update' to re-index it, or remove it first with " +
			"'qmd collection remove C:\\Users\\foo\\my-vault'";
		assert.equal(matches({ stdout: "", stderr }), false);
	});

	test("does NOT match an 'already exists' line about a DIFFERENT name", () => {
		// Guards against an over-broad regex (e.g. /already exists/i) that
		// would match any "already exists" output. The matcher must be bound
		// to the expected name.
		const matches = makeCollectionAddBenignMatcher("obsidian-mind");
		assert.equal(
			matches({
				stdout: "",
				stderr: "Collection 'someone-else' already exists.",
			}),
			false,
		);
	});

	test("does NOT match when output is empty", () => {
		const matches = makeCollectionAddBenignMatcher("obsidian-mind");
		assert.equal(matches({ stdout: "", stderr: "" }), false);
	});

	test("treats the expected name as a literal string (regex metacharacters escaped)", () => {
		// A name like `my-vault.test` should match only literal occurrences,
		// not `my-vaultXtest` etc. Defends against future names that legally
		// contain dots/dashes (allowed by isValidQmdIndex).
		const matches = makeCollectionAddBenignMatcher("my-vault.test");
		assert.equal(
			matches({
				stdout: "",
				stderr: "Collection 'my-vault.test' already exists.",
			}),
			true,
		);
		assert.equal(
			matches({
				stdout: "",
				stderr: "Collection 'my-vaultXtest' already exists.",
			}),
			false,
		);
	});
});
