/**
 * Tests for classify-message: English + inflection + CJK + false-positive +
 * subprocess integration coverage.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { SIGNALS } from "../lib/signals.ts";
import { classify } from "../lib/matcher.ts";
import { runScript as spawnHook } from "./_helpers.ts";

const SCRIPT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../classify-message.ts",
);

function signalNames(prompt: string): string[] {
	const messages = classify(prompt);
	const byMessage = new Map(SIGNALS.map((s) => [s.message, s.name]));
	return messages
		.map((m) => byMessage.get(m) ?? "")
		.filter((n) => n !== "")
		.sort();
}

const runScript = (stdin: string | object | null) => spawnHook(SCRIPT, stdin);

// ---------------------------------------------------------------------------
// English signal detection (TestClassifyEnglish parity)
// ---------------------------------------------------------------------------
describe("classify — English signals", () => {
	test("DECISION", () => {
		assert.ok(signalNames("we decided to use Redis").includes("DECISION"));
	});
	test("INCIDENT", () => {
		assert.ok(signalNames("there was an outage in prod").includes("INCIDENT"));
	});
	test("1:1 CONTENT", () => {
		assert.ok(signalNames("had a 1:1 with my manager").includes("1:1 CONTENT"));
	});
	test("1:1 CONTENT (hyphen form)", () => {
		assert.ok(signalNames("1-1 with Sarah today").includes("1:1 CONTENT"));
	});
	test("WIN", () => {
		assert.ok(signalNames("got kudos from the team").includes("WIN"));
	});
	test("ARCHITECTURE", () => {
		assert.ok(
			signalNames("wrote a tech spec for the API").includes("ARCHITECTURE"),
		);
	});
	test("PERSON CONTEXT", () => {
		assert.ok(
			signalNames("Alice told me about the deadline").includes(
				"PERSON CONTEXT",
			),
		);
	});
	test("PROJECT UPDATE", () => {
		assert.ok(
			signalNames("sprint planning for next week").includes("PROJECT UPDATE"),
		);
	});

	test("overlap — 'shipped' triggers WIN and PROJECT UPDATE", () => {
		const names = signalNames("we shipped the feature");
		assert.ok(names.includes("WIN"));
		assert.ok(names.includes("PROJECT UPDATE"));
	});

	test("overlap — 'deployed' triggers WIN and PROJECT UPDATE", () => {
		const names = signalNames("deployed to production");
		assert.ok(names.includes("WIN"));
		assert.ok(names.includes("PROJECT UPDATE"));
	});

	test("multi-signal — DECISION + INCIDENT", () => {
		const names = signalNames("we decided to fix the incident");
		assert.ok(names.includes("DECISION"));
		assert.ok(names.includes("INCIDENT"));
	});

	test("case insensitivity", () => {
		assert.ok(signalNames("DECIDED to go with option A").includes("DECISION"));
	});

	test("return type is array", () => {
		assert.ok(Array.isArray(classify("hello world")));
	});

	test("return items are strings", () => {
		for (const item of classify("we decided to ship it")) {
			assert.equal(typeof item, "string");
		}
	});
});

// ---------------------------------------------------------------------------
// English inflections (TestClassifyInflections parity)
// ---------------------------------------------------------------------------
describe("classify — English inflections", () => {
	test("deciding", () => {
		assert.ok(
			signalNames("we're still deciding on the approach").includes("DECISION"),
		);
	});
	test("deploying", () => {
		const n = signalNames("deploying the fix right now");
		assert.ok(n.includes("WIN"));
		assert.ok(n.includes("PROJECT UPDATE"));
	});
	test("shipping", () => {
		const n = signalNames("shipping the feature today");
		assert.ok(n.includes("WIN"));
		assert.ok(n.includes("PROJECT UPDATE"));
	});
	test("merging", () => {
		assert.ok(
			signalNames("merging the PR this afternoon").includes("PROJECT UPDATE"),
		);
	});
	test("launching", () => {
		const n = signalNames("launching the new service tomorrow");
		assert.ok(n.includes("WIN"));
		assert.ok(n.includes("PROJECT UPDATE"));
	});
	test("completing", () => {
		const n = signalNames("completing the migration this week");
		assert.ok(n.includes("WIN"));
		assert.ok(n.includes("PROJECT UPDATE"));
	});
	test("releasing", () => {
		const n = signalNames("releasing v2.0 on Friday");
		assert.ok(n.includes("WIN"));
		assert.ok(n.includes("PROJECT UPDATE"));
	});
	test("achieving", () => {
		assert.ok(signalNames("achieving the quarterly target").includes("WIN"));
	});
	test("rolling out", () => {
		assert.ok(
			signalNames("rolling out the new config").includes("PROJECT UPDATE"),
		);
	});
	test("deploys (present -s)", () => {
		const n = signalNames("she deploys to prod every Friday");
		assert.ok(n.includes("WIN"));
		assert.ok(n.includes("PROJECT UPDATE"));
	});
	test("launches", () => {
		const n = signalNames("he launches the service tomorrow");
		assert.ok(n.includes("WIN"));
		assert.ok(n.includes("PROJECT UPDATE"));
	});
	test("ships", () => {
		const n = signalNames("the team ships fast");
		assert.ok(n.includes("WIN"));
		assert.ok(n.includes("PROJECT UPDATE"));
	});
	test("merges", () => {
		assert.ok(signalNames("she merges the PR").includes("PROJECT UPDATE"));
	});
	test("releases", () => {
		const n = signalNames("he releases a new version weekly");
		assert.ok(n.includes("WIN"));
		assert.ok(n.includes("PROJECT UPDATE"));
	});
	test("release cut", () => {
		assert.ok(
			signalNames("did the release cut for v3.4").includes("PROJECT UPDATE"),
		);
	});
});

// ---------------------------------------------------------------------------
// CJK signals (TestClassifyCJK parity with subTest)
// ---------------------------------------------------------------------------
type CJKCase = {
	readonly signal: string;
	readonly prompt: string;
	readonly pattern: string;
};

const CJK_CASES: Readonly<Record<"ja" | "ko" | "zh", readonly CJKCase[]>> = {
	ja: [
		{ signal: "DECISION", prompt: "チームで決定した", pattern: "決定した" },
		{ signal: "INCIDENT", prompt: "インシデントが発生しました", pattern: "インシデント" },
		{
			signal: "1:1 CONTENT",
			prompt: "マネージャーとワンオンワンした",
			pattern: "ワンオンワン",
		},
		{ signal: "WIN", prompt: "新機能をリリースした", pattern: "リリースした" },
		{
			signal: "ARCHITECTURE",
			prompt: "アーキテクチャの見直しが必要",
			pattern: "アーキテクチャ",
		},
		{ signal: "PERSON CONTEXT", prompt: "田中さんが言ってた", pattern: "言ってた" },
		{
			signal: "PROJECT UPDATE",
			prompt: "今週のスプリントで完了する",
			pattern: "スプリント",
		},
	],
	ko: [
		{ signal: "DECISION", prompt: "결정했습니다", pattern: "결정했습니다" },
		{ signal: "INCIDENT", prompt: "장애가 발생했습니다", pattern: "장애" },
		{ signal: "1:1 CONTENT", prompt: "원온원 미팅을 했습니다", pattern: "원온원" },
		{ signal: "WIN", prompt: "서비스를 출시했어", pattern: "출시했어" },
		{ signal: "ARCHITECTURE", prompt: "아키텍처 리뷰를 했습니다", pattern: "아키텍처" },
		{ signal: "PERSON CONTEXT", prompt: "김 매니저가 말했어", pattern: "말했어" },
		{ signal: "PROJECT UPDATE", prompt: "이번 스프린트에서 완료", pattern: "스프린트" },
	],
	zh: [
		{ signal: "DECISION", prompt: "我们决定了这个方案", pattern: "决定了" },
		{ signal: "INCIDENT", prompt: "发生了故障需要处理", pattern: "故障" },
		{ signal: "1:1 CONTENT", prompt: "今天有一对一会议", pattern: "一对一" },
		{ signal: "WIN", prompt: "新版本发布了", pattern: "发布了" },
		{ signal: "ARCHITECTURE", prompt: "系统架构需要重新设计", pattern: "架构" },
		{ signal: "PERSON CONTEXT", prompt: "他提到了这个问题", pattern: "提到" },
		{ signal: "PROJECT UPDATE", prompt: "这个迭代的进展报告", pattern: "迭代" },
	],
};

describe("classify — CJK signals", () => {
	for (const lang of ["ja", "ko", "zh"] as const) {
		for (const c of CJK_CASES[lang]) {
			test(`${lang}: ${c.pattern} → ${c.signal}`, () => {
				assert.ok(
					signalNames(c.prompt).includes(c.signal),
					`${lang} pattern '${c.pattern}' should trigger ${c.signal}`,
				);
			});
		}
	}

	test("mixed CJK + English (Japanese hiragana)", () => {
		assert.ok(signalNames("のdecisionについて").includes("DECISION"));
	});

	test("mixed CJK + English (Chinese)", () => {
		assert.ok(signalNames("我们decided了").includes("DECISION"));
	});

	test("mixed CJK + English (Korean)", () => {
		assert.ok(signalNames("오늘 1:1 미팅").includes("1:1 CONTENT"));
	});

	test("CJK overlap — Chinese delivery word triggers WIN and PROJECT UPDATE", () => {
		const n = signalNames("新版本发布了");
		assert.ok(n.includes("WIN"));
		assert.ok(n.includes("PROJECT UPDATE"));
	});

	test("CJK false positive (Japanese)", () => {
		assert.deepEqual(signalNames("普通の会話です"), []);
	});

	test("CJK false positive (Korean)", () => {
		assert.deepEqual(signalNames("코드 리뷰를 합시다"), []);
	});

	test("CJK false positive (Chinese)", () => {
		assert.deepEqual(signalNames("今天天气不错"), []);
	});
});

// ---------------------------------------------------------------------------
// False positives (TestClassifyFalsePositives parity)
// ---------------------------------------------------------------------------
describe("classify — no false positives", () => {
	const NO_SIGNAL_CASES: ReadonlyArray<readonly [string, string]> = [
		["downloading the markdown file", "download ≠ any trigger"],
		["hello world", "generic greeting"],
		["just reading some code", "generic activity"],
		["the function returns an error", "generic error"],
		["I wonder about the implementation", "wonder ≠ won"],
		["she is predecisioned on this", "predecisioned ≠ decision"],
		["unshipped items in the backlog", "unshipped ≠ shipped"],
		["acknowledged the problem", "no trigger words"],
	];

	for (const [prompt, reason] of NO_SIGNAL_CASES) {
		test(`should not trigger: ${reason}`, () => {
			assert.deepEqual(signalNames(prompt), [], `Should not trigger: ${reason}`);
		});
	}

	test("empty string", () => {
		assert.deepEqual(classify(""), []);
	});
});

// ---------------------------------------------------------------------------
// Subprocess integration (TestClassifyIntegration parity + new edge cases)
// ---------------------------------------------------------------------------
describe("classify-message (subprocess)", () => {
	test("valid JSON with signal", () => {
		const { stdout, code } = runScript({ prompt: "we decided to use React" });
		assert.equal(code, 0);
		const data = JSON.parse(stdout) as {
			hookSpecificOutput: {
				hookEventName: string;
				additionalContext: string;
			};
		};
		assert.equal(data.hookSpecificOutput.hookEventName, "UserPromptSubmit");
		assert.ok(data.hookSpecificOutput.additionalContext.includes("DECISION"));
	});

	test("valid JSON no signal", () => {
		const { stdout, code } = runScript({ prompt: "hello world" });
		assert.equal(code, 0);
		assert.equal(stdout.trim(), "");
	});

	test("invalid JSON", () => {
		const { code } = runScript("not json{{");
		assert.equal(code, 0);
	});

	test("missing prompt", () => {
		const { code } = runScript({ foo: "bar" });
		assert.equal(code, 0);
	});

	test("non-string prompt", () => {
		const { code } = runScript({ prompt: 123 });
		assert.equal(code, 0);
	});

	test("null prompt", () => {
		const { code } = runScript({ prompt: null });
		assert.equal(code, 0);
	});

	test("empty stdin", () => {
		const { code } = runScript(null);
		assert.equal(code, 0);
	});

	test("empty prompt string", () => {
		const { code } = runScript({ prompt: "" });
		assert.equal(code, 0);
	});

	// --- New: edge cases not in Python ---

	test("preserves hook_event_name from input", () => {
		const { stdout } = runScript({
			prompt: "we decided",
			hook_event_name: "SomeCustomEvent",
		});
		const data = JSON.parse(stdout) as {
			hookSpecificOutput: { hookEventName: string };
		};
		assert.equal(data.hookSpecificOutput.hookEventName, "SomeCustomEvent");
	});

	test("handles truncated JSON gracefully", () => {
		const { code } = runScript('{"prompt":"decide');
		assert.equal(code, 0);
	});

	test("handles very large input without crash (500KB)", () => {
		const big = "x".repeat(500_000) + " we decided";
		const { code, stdout } = runScript({ prompt: big });
		assert.equal(code, 0);
		assert.ok(stdout.includes("DECISION"));
	});
});

// ---------------------------------------------------------------------------
// Perf bound
// ---------------------------------------------------------------------------
describe("classify — performance", () => {
	test("1MB input classifies in under 500ms", () => {
		const input = "lorem ipsum ".repeat(90_000) + " we decided to ship it";
		const start = performance.now();
		const result = classify(input);
		const elapsed = performance.now() - start;
		assert.ok(
			elapsed < 500,
			`classify took ${elapsed.toFixed(1)}ms on ~1MB input (budget 500ms)`,
		);
		assert.ok(result.length > 0);
	});
});
