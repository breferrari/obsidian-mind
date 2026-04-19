/**
 * Unit tests for lib/hook-io — stderr helpers shared across hooks and scripts.
 * readStdinJson is exercised via integration tests; here we lock the tiny
 * stderr formatters so message shape stays consistent.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import { debug, warn } from "../lib/hook-io.ts";

/**
 * Replace process.stderr.write with a capturer that records calls and returns
 * true (matching the real write() signature). Returns a restorer that
 * reinstates the original, plus the captured lines.
 */
function captureStderr(): {
	lines: string[];
	restore: () => void;
} {
	const lines: string[] = [];
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string | Uint8Array) => {
		lines.push(typeof chunk === "string" ? chunk : chunk.toString());
		return true;
	}) as typeof process.stderr.write;
	return { lines, restore: () => (process.stderr.write = original) };
}

describe("warn", () => {
	let capture: ReturnType<typeof captureStderr>;

	afterEach(() => capture?.restore());

	test("prefixes the message with `  ⚠ ` and appends a newline", () => {
		capture = captureStderr();
		warn("something went wrong");
		assert.deepEqual(capture.lines, ["  ⚠ something went wrong\n"]);
	});

	test("writes nothing else when called with empty string", () => {
		capture = captureStderr();
		warn("");
		assert.deepEqual(capture.lines, ["  ⚠ \n"]);
	});
});

describe("debug", () => {
	const originalFlag = process.env["HOOK_DEBUG"];
	let capture: ReturnType<typeof captureStderr>;

	afterEach(() => {
		capture?.restore();
		if (originalFlag === undefined) {
			delete process.env["HOOK_DEBUG"];
		} else {
			process.env["HOOK_DEBUG"] = originalFlag;
		}
	});

	test("silent when HOOK_DEBUG is unset", () => {
		delete process.env["HOOK_DEBUG"];
		capture = captureStderr();
		debug("should not appear");
		assert.deepEqual(capture.lines, []);
	});

	test("silent when HOOK_DEBUG is not exactly '1'", () => {
		process.env["HOOK_DEBUG"] = "true";
		capture = captureStderr();
		debug("should not appear");
		assert.deepEqual(capture.lines, []);
	});

	test("writes a tagged line to stderr when HOOK_DEBUG=1", () => {
		process.env["HOOK_DEBUG"] = "1";
		capture = captureStderr();
		debug("taking path A");
		assert.equal(capture.lines.length, 1);
		assert.match(
			capture.lines[0] ?? "",
			/^\[hook-debug \d{4}-\d{2}-\d{2}T[^\]]+\] taking path A\n$/,
		);
	});
});
