/**
 * Unit tests for lib/hook-io — stderr helpers shared across hooks and scripts.
 * readStdinJson is exercised via integration tests; here we lock the tiny
 * stderr formatters so message shape stays consistent.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import { debug, fitEncoded, HOOK_OUTPUT_MAX_CHARS, warn, writeHookOutput, writeStopFeedback, writeSystemMessage, type PolicyResult } from "../lib/hook-io.ts";

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
describe("writeStopFeedback — the whole output fits", () => {
	test("a huge report and summary fill the cap exactly, both marked as cut, and never as a block", () => {
		const out = captureStdout(() => writeStopFeedback("x".repeat(20_000), "x".repeat(20_000)));
		assert.equal(out.length, HOOK_OUTPUT_MAX_CHARS);
		const parsed = JSON.parse(out) as { decision?: string; systemMessage: string; hookSpecificOutput: { hookEventName: string; additionalContext: string } };
		assert.equal(parsed.decision, undefined, "a block is printed in full and labelled an error");
		assert.equal(parsed.hookSpecificOutput.hookEventName, "Stop");
		assert.match(parsed.hookSpecificOutput.additionalContext, /truncated to fit the hook output cap\)$/);
		assert.match(parsed.systemMessage, /truncated to fit the hook output cap\)$/);
		assert.ok(parsed.hookSpecificOutput.additionalContext.length > parsed.systemMessage.length, "the agent's copy gets the larger share");
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

	test("at every policy size near the edge, the whole stdout stays within the cap", () => {
		// Sweeps the boundary where the context's room is about the marker's size,
		// which a single large fixture cannot reach.
		const shell = JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "", policyResults: [{ policy_id: "r", path: "", classification: "c", action: "warn" }] } }).length;
		for (let pathLen = HOOK_OUTPUT_MAX_CHARS - shell - 80; pathLen <= HOOK_OUTPUT_MAX_CHARS - shell + 5; pathLen++) {
			const policy: PolicyResult[] = [{ policy_id: "r", path: "p".repeat(pathLen), classification: "c", action: "warn" }];
			const out = captureStdout(() => writeHookOutput("PostToolUse", "x".repeat(20_000), policy));
			assert.ok(out.length <= HOOK_OUTPUT_MAX_CHARS, `policy path ${pathLen}: stdout is ${out.length} characters`);
		}
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

describe("writeStopReportData", () => {
	test("a report too large for one pipe write arrives whole", async () => {
		const { spawnSync } = await import("node:child_process");
		const lib = new URL("../lib/hook-io.ts", import.meta.url).href;
		const agentText = "x".repeat(2_000_000);
		const script = `import { writeStopReportData } from ${JSON.stringify(lib)}; writeStopReportData({ key: "k", claims: ["c"], agentText: "x".repeat(${agentText.length}) });`;
		const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", "--input-type=module", "-e", script], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
		assert.equal(run.status, 0, run.stderr);
		const parsed = JSON.parse(run.stdout) as { report: { agentText: string } };
		assert.equal(parsed.report.agentText.length, agentText.length);
	});
});
