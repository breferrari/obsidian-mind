/**
 * `reason` — judgement over vault context, in a spawned session.
 *
 * This is tier 3 of the ladder in ARCHITECTURE.md, but nothing a user touches
 * says "tier 3": the tool is `reason` and the manifest block is `reason`. The
 * tier numbering is our taxonomy for the design, not a name anyone should have
 * to learn to configure a model pin.
 *
 * Some questions cannot be answered by retrieving a passage, because they need
 * judgement ACROSS notes: is what I am about to do consistent with what these
 * six notes decided, and what do I do about the two that disagree? Retrieval
 * returns the notes. Something has to read them.
 *
 * It spawns because a server cannot borrow the calling session's inference —
 * MCP calls that sampling, and Claude Code does not implement it
 * (anthropics/claude-code#1785). So it starts a session through the user's own
 * CLI, which is also why it passes no `--model`: MCP does not expose the
 * caller's model, and the CLI's own default is the closest match to the level
 * the caller is already working at.
 *
 * The spawn is isolated (`--strict-mcp-config` against an empty server map, so
 * it cannot call back into `om`), read-only, and seeded with tier-1 results so
 * it does not spend turns rediscovering what the server already has. Every
 * invocation is appended to the audit log with its cost, turns, model and wall
 * time.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

/** Where an answer and its provenance are written. */
export const REASONING_DIR = ".claude/om-reasoning";

export interface ReasonConfig {
	/**
	 * null — the usual case — means DO NOT pass `--model`, so the spawn runs on
	 * the user's own CLI default: whatever they would get typing `claude`.
	 *
	 * MCP gives a server no way to see the calling session's model, so inheriting
	 * the CLI default is the closest reachable thing to "the same model I am
	 * using". Pinning one here would quietly hand back worse answers than the
	 * caller's own session would produce, for a choice that is theirs.
	 *
	 * A vault that wants to pin one sets it, and then it must be a FULL id:
	 * `--model haiku` is not honoured and does not error — it silently runs
	 * sonnet. An alias is ignored rather than passed on.
	 */
	readonly model: string | null;
}

export const REASON_DEFAULTS: ReasonConfig = {
	// Inherit. The model is the user's choice, made once, for their own reasons.
	model: null,
};

/**
 * How long a spawn may run before it is killed.
 *
 * Fixed, not configurable: this bounds a HUNG CHILD, which is a failure rather
 * than a preference. Nobody wants a wedged process, and nobody has a reason to
 * want a different number for it.
 */
const SPAWN_TIMEOUT_MS = 300_000;

/** A model id the CLI will honour: `family-version`, not a bare alias. */
const FULL_MODEL_ID = /^claude-[a-z]+-[0-9]/;

/**
 * Read the manifest's `reason` block. Exactly one thing is configurable — a model
 * pin — and it defaults to using the user's own Claude settings.
 *
 * Pure, so the decision can be driven by a test without spawning anything.
 */
export function resolveReasonConfig(manifest: Record<string, unknown> | null | undefined): ReasonConfig {
	const raw = (manifest?.reason ?? {}) as Record<string, unknown>;
	// An alias, or anything unset, falls back to inheriting rather than to a
	// hardcoded id — a wrong pin is worse than no pin.
	return { model: typeof raw.model === "string" && FULL_MODEL_ID.test(raw.model) ? raw.model : null };
}

/**
 * What this vault's reasoning has cost today, from the audit log.
 *
 * Reported by `health`, and used for nothing else — it does not gate a call.
 * Nothing here bounds usage, so this is the whole of the answer to "where did
 * it go", and it reads from the log already written on every invocation rather
 * than from a second counter that could disagree with it.
 *
 * Unparseable lines are skipped rather than throwing.
 */
export function spentToday(auditPath: string, today: string): number {
	let text: string;
	try {
		text = readFileSync(auditPath, "utf8");
	} catch {
		return 0;
	}
	let total = 0;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line) as { action?: string; at?: string; cost_usd?: number };
			if (e.action !== "reason") continue;
			if (typeof e.at !== "string" || !e.at.startsWith(today)) continue;
			if (typeof e.cost_usd === "number" && Number.isFinite(e.cost_usd)) total += e.cost_usd;
		} catch {
			/* a torn or hand-edited line is skipped, never fatal */
		}
	}
	return total;
}

export interface ReasoningResult {
	readonly ok: boolean;
	/** Empty when the run was cut short; never a partial answer. */
	readonly answer: string;
	readonly costUsd: number;
	readonly turns: number;
	/** The model the CLI reports actually running, which is not always the one asked for. */
	readonly modelUsed: string;
	/** Why the CLI stopped — reported verbatim, so an early end can be named. */
	readonly terminal: string;
	readonly wallMs: number;
	readonly error: string | null;
}

/**
 * The tools the spawn may use: enough to read the whole vault, and nothing that
 * writes. `--tools` restricts the built-in set itself, so a blocked call comes
 * back as "No such tool available: Write" rather than as a permission prompt
 * nothing is there to answer.
 *
 * NOT `--permission-mode plan`, which was the first attempt and is wrong twice
 * over. It is not read-only — it writes the plan to `~/.claude/plans/`, outside
 * the vault entirely — and, worse, it changes what the spawn thinks it is
 * producing. In a measured run the model composed its analysis AS A PLAN, tried
 * to hand it back through `ExitPlanMode`, found no such tool headlessly, wrote
 * the content to a plan file, and returned a one-line note about having done so.
 * The entire answer was lost, and the failure is non-deterministic: an earlier
 * run of the same build answered normally.
 */
const READ_ONLY_TOOLS = "Read,Grep,Glob";

/** Build the argv. Separated so the flags can be asserted without spawning. */
export function reasoningArgs(cfg: ReasonConfig, prompt: string, mcpConfigPath: string): string[] {
	return [
		"-p",
		prompt,
		// Omitted unless the vault pinned one, so the spawn runs on the user's own
		// CLI default rather than on a model this server chose for them.
		...(cfg.model ? ["--model", cfg.model] : []),
		"--output-format",
		"json",
		// The recursion guard. With an empty server map this leaves the spawn no
		// MCP at all, so it cannot call back into this server and start a loop
		// that multiplies at every level. Verified: the spawn reports no MCP servers.
		"--strict-mcp-config",
		"--mcp-config",
		mcpConfigPath,
		// A reasoning pass answers; it does not edit the vault.
		"--tools",
		READ_ONLY_TOOLS,
	];
}

/**
 * Compose the prompt.
 *
 * Seeded with tier-1 evidence so the spawn does not pay turns rediscovering what
 * the server already has. Measured, that saves about a turn — less than the
 * foreign-cwd comparison suggested, because a spawn with `cwd` = the vault
 * already inherits the contract.
 *
 * It also biases: in a measured run the seeded answer leaned on the passages and
 * repeated a framing the vault had since corrected. Hence the explicit licence
 * to go further, and the instruction to say when the evidence is thin.
 */
export function reasoningPrompt(question: string, evidence: string): string {
	const common = [
		"Answer directly, with no preamble about what you are about to do. Cite the note",
		"paths you relied on. Preserve any '(TBC)', '(inferred)' or 'as of <date>' markers",
		"you find, and never promote an inferred claim to a stated one.",
	];

	// An empty seed means the INDEX had nothing, which is not the same as the
	// vault having nothing — a vault with no index built yet returns exactly this.
	// Measured: handed an empty seed under the normal wording, the spawn reported
	// "no prior decisions recorded" about a question the vault answered in a note
	// sitting one directory away. That is this layer's signature failure, so the
	// empty case gets its own instructions rather than a blank evidence block.
	if (!hasEvidence(evidence)) {
		return [
			question,
			"",
			"Vault search returned nothing usable — the index may be missing or stale, so",
			"this is NOT evidence that the vault is silent on the question. You are running",
			"inside the vault: read it directly. Look through the note tree yourself before",
			"concluding anything.",
			"",
			"Only report that nothing is recorded if you have actually looked and found",
			"nothing, and say how you looked.",
			"",
			...common,
		].join("\n");
	}

	return [
		question,
		"",
		"Vault search has already returned the passages below. Start from them rather",
		"than searching from scratch, but treat them as a starting point and not as the",
		"whole record — you are running inside the vault, so read further when they are",
		"thin, and say so when they are.",
		"",
		...common,
		"",
		"<evidence>",
		evidence,
		"</evidence>",
	].join("\n");
}

/**
 * Did the seeding search actually find anything?
 *
 * `qmdSearch` reports its own failures in prose — "(no results)", "search
 * failed: …", "(search unavailable…)" — so an empty seed and a broken index
 * arrive as text rather than as an error, and both must be recognised.
 */
export function hasEvidence(evidence: string): boolean {
	const t = String(evidence ?? "").trim();
	if (!t) return false;
	return !/^\((no results|search unavailable)|^search failed:/i.test(t);
}

/**
 * Run the spawn and read its telemetry.
 *
 * Spawns the binary DIRECTLY with argv — never through a shell. On Windows
 * `cmd.exe` strips the quotes out of an inline JSON argument and the CLI then
 * tries to open the mangled string as a file path; the same class of failure as
 * a shell rewriting an array join.
 *
 * `stdio.stdin` is closed explicitly. Left open, the CLI waits on it and the
 * call hangs until the timeout rather than answering.
 */
export function runReasoning(
	claudeBin: string,
	vaultRoot: string,
	cfg: ReasonConfig,
	prompt: string,
	mcpConfigPath: string,
): ReasoningResult {
	const started = Date.now();
	const empty = (error: string, wallMs: number): ReasoningResult => ({
		ok: false,
		answer: "",
		costUsd: 0,
		turns: 0,
		modelUsed: "",
		terminal: "spawn_failed",
		wallMs,
		error,
	});

	let r;
	try {
		r = spawnSync(claudeBin, reasoningArgs(cfg, prompt, mcpConfigPath), {
			cwd: vaultRoot,
			encoding: "utf8",
			timeout: SPAWN_TIMEOUT_MS,
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (e) {
		return empty(e instanceof Error ? e.message : String(e), Date.now() - started);
	}
	const wallMs = Date.now() - started;

	let j: Record<string, unknown>;
	try {
		j = JSON.parse(r.stdout ?? "") as Record<string, unknown>;
	} catch {
		// A non-JSON body means the CLI never got far enough to report. Whatever it
		// printed is the only diagnostic there is.
		const why = String(r.stderr || r.stdout || "no output").slice(0, 300);
		return empty(r.error ? r.error.message : why, wallMs);
	}

	const usage = (j.modelUsage ?? {}) as Record<string, unknown>;
	const terminal = typeof j.terminal_reason === "string" ? j.terminal_reason : "unknown";
	const costUsd = typeof j.total_cost_usd === "number" ? j.total_cost_usd : 0;

	return {
		// `is_error` covers budget exhaustion, which is the outcome this must never
		// present as a complete answer.
		ok: j.is_error !== true,
		answer: typeof j.result === "string" ? j.result : "",
		costUsd,
		turns: typeof j.num_turns === "number" ? j.num_turns : 0,
		modelUsed: Object.keys(usage).join(",") || "unknown",
		terminal,
		wallMs,
		error: null,
	};
}

/** Human-readable refusal, so a caller learns what to change. */
export function describeRefusal(reason: string, detail: string): string {
	return `Not run: ${reason}\n\n${detail}`;
}

/**
 * Which binary to spawn.
 *
 * `OM_CLAUDE_BIN` first, because a user whose CLI is not on this process's PATH
 * has no other way to say so — and a spawn that cannot find its binary is
 * otherwise just an opaque failure.
 */
export function resolveClaudeBin(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.OM_CLAUDE_BIN;
	return override && override.trim() ? override.trim() : "claude";
}

/**
 * An MCP config declaring NO servers, written once per vault.
 *
 * Paired with `--strict-mcp-config` this is the recursion guard: the spawn
 * inherits no MCP at all, so it cannot reach back into this server and start a
 * loop that multiplies at every level. Verified — a spawn under these flags reports
 * no MCP servers available.
 */
export function writeIsolatedMcpConfig(vaultRoot: string): string {
	const path = join(vaultRoot, REASONING_DIR, "no-mcp.json");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ mcpServers: {} }), "utf8");
	return path;
}

/**
 * Persist the question, the answer and what it cost.
 *
 * Gitignored, beside the audit log: a tier-3 conclusion is INFERRED, so it does
 * not belong in the vault as a note and is deliberately not recorded as a
 * memory. The calling session decides whether any of it is worth a `remember` —
 * auto-recording machine reasoning is how a store fills with claims nobody
 * asked for and nobody verified.
 *
 * Returns null on failure: losing the transcript must not lose the answer.
 */
export function writeReasoningRecord(
	vaultRoot: string,
	now: Date,
	question: string,
	r: ReasoningResult,
): string | null {
	const stamp = now.toISOString().replace(/[:.]/g, "-");
	const rel = `${REASONING_DIR}/${stamp}.md`;
	try {
		const full = join(vaultRoot, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(
			full,
			[
				"---",
				`date: ${now.toISOString()}`,
				"source: mcp-reason",
				`cost_usd: ${r.costUsd}`,
				`turns: ${r.turns}`,
				`model: ${r.modelUsed}`,
				`confidence: inferred`,
				"---",
				"",
				"# Question",
				"",
				question,
				"",
				"# Answer",
				"",
				r.answer.trim(),
				"",
			].join("\n"),
			"utf8",
		);
		return rel;
	} catch {
		return null;
	}
}
