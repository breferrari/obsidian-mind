/**
 * Unit tests for lib/regex — regex metacharacter escaping.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { escapeRegex } from "../lib/regex.ts";

describe("escapeRegex", () => {
	test("passes plain letters and digits unchanged", () => {
		assert.equal(escapeRegex("abcXYZ123"), "abcXYZ123");
	});

	test("escapes every regex metacharacter", () => {
		// All 13 special chars from the escape class: . * + ? ^ $ { } ( ) | [ ] \
		assert.equal(
			escapeRegex(".*+?^${}()|[]\\"),
			"\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\",
		);
	});

	test("escaped output is safe inside new RegExp()", () => {
		const literal = "a.b*c+d?";
		const re = new RegExp(escapeRegex(literal));
		assert.ok(re.test("a.b*c+d?"));
		assert.ok(!re.test("axbXcYdZ"));
	});

	test("preserves non-meta characters adjacent to meta characters", () => {
		assert.equal(escapeRegex("foo.bar"), "foo\\.bar");
		assert.equal(escapeRegex("a(b)c"), "a\\(b\\)c");
	});

	test("empty string passes through unchanged", () => {
		assert.equal(escapeRegex(""), "");
	});

	test("already-escaped sequences get double-escaped (literal preservation)", () => {
		// Input is the literal two-character sequence backslash-dot.
		// Both characters are meta; both must be escaped so the resulting
		// regex matches a literal backslash followed by a literal dot.
		assert.equal(escapeRegex("\\."), "\\\\\\.");
		const re = new RegExp(escapeRegex("\\."));
		assert.ok(re.test("\\."));
		assert.ok(!re.test("."));
	});
});
