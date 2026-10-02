/**
 * Unit tests for lib/hook-io — stderr helpers shared across hooks and scripts.
 * readStdinJson is exercised via integration tests; here we lock the tiny
 * stderr formatters so message shape stays consistent.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import { debug, fitEncoded, HOOK_OUTPUT_MAX_CHARS, warn, writeHookOutput, writeStopBlock, writeSystemMessage, type PolicyResult } from "../lib/hook-io.ts";

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

/** What `write` printed to stdout. */
function captureStdout(write: () => void): string {
	const chunks: string[] = [];
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string) => {
		chunks.push(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		write();
	} finally {
		process.stdout.write = original;
	}
	return chunks.join("");
}

// "x" encodes to one character, so the cut can land exactly on the cap:
// these tests assert the exact length, which catches an off-by-one either way.
describe("writeStopBlock — the whole output fits", () => {
	test("a huge report fills the cap exactly, marked as cut, and is the only field", () => {
		const out = captureStdout(() => writeStopBlock("x".repeat(20_000)));
		assert.equal(out.length, HOOK_OUTPUT_MAX_CHARS);
		const parsed = JSON.parse(out) as Record<string, string>;
		assert.deepEqual(Object.keys(parsed), ["decision", "reason"]);
		assert.equal(parsed["decision"], "block");
		assert.match(parsed["reason"] ?? "", /truncated to fit the hook output cap\)$/);
	});
});

describe("writeSystemMessage — the output fits", () => {
	test("a huge message fills the cap exactly, marked as cut", () => {
		const out = captureStdout(() => writeSystemMessage("x".repeat(20_000)));
		assert.equal(out.length, HOOK_OUTPUT_MAX_CHARS);
		assert.match((JSON.parse(out) as { systemMessage: string }).systemMessage, /truncated to fit the hook output cap\)$/);
	});

	test("a short message is written unchanged", () => {
		assert.equal(captureStdout(() => writeSystemMessage("hello")), '{"systemMessage":"hello"}');
	});
});

describe("writeHookOutput — additionalContext fits the hook output cap (#254)", () => {
	test("a huge context is cut with the marker, and the whole stdout fills the cap exactly", () => {
		const out = captureStdout(() => writeHookOutput("PostToolUse", "x".repeat(20_000)));
		assert.equal(out.length, HOOK_OUTPUT_MAX_CHARS);
		const context = (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
		assert.match(context, /truncated to fit the hook output cap\)$/);
	});

	test("policy results take their share of the cap, not more of it", () => {
		const policy: PolicyResult[] = Array.from({ length: 3 }, (_, i) => ({ policy_id: `rule-${i}`, path: `notes/${"y".repeat(300)}.md`, classification: "misplaced", action: "warn" }));
		const out = captureStdout(() => writeHookOutput("PostToolUse", "x".repeat(20_000), policy));
		assert.equal(out.length, HOOK_OUTPUT_MAX_CHARS);
		assert.equal((JSON.parse(out) as { hookSpecificOutput: { policyResults: unknown[] } }).hookSpecificOutput.policyResults.length, 3);
	});

	test("policy results too large to fit beside any context are dropped, never carried over the cap", () => {
		const policy: PolicyResult[] = Array.from({ length: 3 }, (_, i) => ({ policy_id: `rule-${i}`, path: `notes/${"y".repeat(4_000)}.md`, classification: "misplaced", action: "warn" }));
		const out = captureStdout(() => writeHookOutput("PostToolUse", "x".repeat(20_000), policy));
		assert.ok(out.length <= HOOK_OUTPUT_MAX_CHARS, `stdout is ${out.length} characters`);
		const parsed = JSON.parse(out) as { hookSpecificOutput: { additionalContext: string; policyResults?: unknown[] } };
		assert.equal(parsed.hookSpecificOutput.policyResults, undefined);
		assert.match(parsed.hookSpecificOutput.additionalContext, /truncated to fit the hook output cap\)$/);
	});

	test("a short context is written unchanged", () => {
		const out = captureStdout(() => writeHookOutput("PostToolUse", "hello"));
		assert.equal(out, '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"hello"}}');
	});
});
