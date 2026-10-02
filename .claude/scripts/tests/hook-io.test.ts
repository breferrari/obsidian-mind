/**
 * Unit tests for lib/hook-io — stderr helpers shared across hooks and scripts.
 * readStdinJson is exercised via integration tests; here we lock the tiny
 * stderr formatters so message shape stays consistent.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import { debug, fitEncoded, HOOK_OUTPUT_MAX_CHARS, warn, writeStopBlock } from "../lib/hook-io.ts";

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

/** Half of a surrogate pair with its other half missing. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("fitEncoded — held under the hook output cap", () => {
	test("text that fits is returned unchanged", () => {
		assert.equal(fitEncoded("short", 100), "short");
	});

	test("counts JSON escaping, which a cut on raw length would miss", () => {
		// 3,000 backslashes encode to 6,000 characters.
		const text = "\\".repeat(3_000);
		const fitted = fitEncoded(text, 4_000);
		assert.ok(JSON.stringify(fitted).length <= 4_000, `got ${JSON.stringify(fitted).length}`);
		assert.match(fitted, /… \(truncated to fit the hook output cap\)$/);
	});

	test("never leaves half of an astral emoji", () => {
		// Each 🚨 is two UTF-16 units, so a cut on raw length would split one
		// at every odd cap. Counting the encoded length is what prevents it.
		for (let max = 200; max < 206; max++) {
			const fitted = fitEncoded("🚨".repeat(500), max);
			assert.doesNotMatch(fitted, LONE_SURROGATE, `max ${max} left a lone surrogate`);
		}
	});
});

describe("writeStopBlock — the whole output fits", () => {
	test("a huge report and message still come out under the cap, both marked as cut", () => {
		const chunks: string[] = [];
		const original = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string) => {
			chunks.push(chunk);
			return true;
		}) as typeof process.stdout.write;
		try {
			writeStopBlock("r\n".repeat(20_000), "m\n".repeat(20_000));
		} finally {
			process.stdout.write = original;
		}
		const out = chunks.join("");
		assert.ok(out.length <= HOOK_OUTPUT_MAX_CHARS, `got ${out.length}`);
		const parsed = JSON.parse(out) as { decision: string; reason: string; systemMessage: string };
		assert.equal(parsed.decision, "block");
		assert.match(parsed.reason, /truncated to fit the hook output cap\)$/);
		assert.match(parsed.systemMessage, /truncated to fit the hook output cap\)$/);
		assert.ok(parsed.reason.length > parsed.systemMessage.length, "the agent's copy gets the larger share");
	});
});
