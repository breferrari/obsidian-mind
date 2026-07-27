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

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";

const require = createRequire(import.meta.url);

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

/**
 * The audit log's name for this tool, exported so the stamp and the read of it
 * move together. Renamed on one side only, the daily figure silently reads zero
 * forever — indistinguishable from "no calls today". Same reason `MEMORY_SOURCE`
 * is re-exported from the writer that stamps it.
 */
export const REASON_ACTION = "reason";

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
 * The audit detail for one run, built HERE so the fields and the reader of them
 * stay in one module rather than being composed a layer up.
 */
export function reasonAuditDetail(
	question: string,
	cfg: ReasonConfig,
	r: ReasoningResult,
	scope: ReasoningScope | undefined,
): Record<string, unknown> {
	return {
		question,
		cost_usd: r.costUsd,
		turns: r.turns,
		terminal: r.terminal,
		model_asked: cfg.model,
		model_used: r.modelUsed,
		wall_ms: r.wallMs,
		// What the spawn was TOLD it could read. The boundary is observed by the
		// spawn rather than enforced by the filesystem, so recording it is what
		// keeps "what did that session actually see" answerable afterwards.
		roots: scope ? scope.roots.join(",") : "vault-wide",
	};
}

/**
 * What this vault's reasoning has cost today, as one line for `health`.
 *
 * Reported and used for nothing else — it does not gate a call. Nothing here
 * bounds usage, so this line is the whole of the answer to "where did it go",
 * and it reads the log already written on every invocation rather than a second
 * counter that could disagree with it.
 *
 * Composed here rather than in the server so the wiring layer interpolates a
 * string instead of knowing this tool's audit key, its config, and where the log
 * lives — and so it can be tested without a wire.
 */
export function reasonUsage(
	vaultRoot: string,
	manifest: Record<string, unknown> | null | undefined,
	today: string,
	readSpend: (vaultRoot: string, action: string, day: string, field: string) => number,
): string {
	const spent = readSpend(vaultRoot, REASON_ACTION, today, "cost_usd");
	const model = resolveReasonConfig(manifest).model ?? "your CLI default";
	const usage = spent > 0 ? `$${spent.toFixed(4)} reported across today's calls` : "nothing yet today";
	return `${usage} · model: ${model}`;
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

/** Which of the vault the spawn may read, mirroring the exposure policy. */
export interface ReasoningScope {
	/** The exposure policy's roots — the folders this vault serves. */
	readonly roots: readonly string[];
	/** The memory root, which is never readable as an ordinary note. */
	readonly memoryRoot: string;
}

/**
 * The spawn's read boundary, stated as a PROHIBITION.
 *
 * `--tools Read,Grep,Glob` with `cwd` at the vault root gives the spawn the
 * whole tree, while the seed it was handed went through `allowedSearchPaths`.
 * Without this the two disagree, and the one tool that reads most is the one
 * that ignores `mcp_exposed_roots` — which exists for the vault holding material
 * that is not the user's to share. The memory root is named separately because
 * "memories are never served as an ordinary note" holds whatever the config
 * says, and a spawn reading `memories/` directly sees every caller's, not its
 * own.
 *
 * A prohibition rather than a request, because that is the form measured to
 * propagate reliably into a session — a positive "consult X" is advisory and
 * gets skipped whenever something nearer answers. It is a boundary the spawn
 * observes, not one the filesystem enforces; the audit line records the roots so
 * what it was told is recoverable afterwards.
 */
function boundary(scope: ReasoningScope | undefined): string[] {
	if (!scope || scope.roots.length === 0) return [];
	return [
		`Read ONLY within these folders: ${scope.roots.join(", ")}. Do not read anything`,
		`outside them, and never read ${scope.memoryRoot}/ or .claude/ — those are not yours`,
		"to quote. If the answer would require a note outside that boundary, say so instead",
		"of reading it.",
		"",
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
export function reasoningPrompt(question: string, evidence: string, scope?: ReasoningScope): string {
	const common = [
		...boundary(scope),
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
 * The prose `qmdSearch` returns INSTEAD of an error when it found nothing or
 * broke. Prefixes, matched against the start of the seed — a passage that merely
 * quotes one of these phrases is still evidence.
 */
const NO_EVIDENCE_PREFIXES = ["(no results", "(search unavailable", "search failed:"] as const;

/**
 * Did the seeding search actually find anything?
 *
 * `qmdSearch` reports its own failures in prose rather than by throwing, so an
 * empty index and a broken one both arrive as text and both must be recognised.
 *
 * This is the FALLBACK signal. Prefer `visibleHits` when the caller still holds
 * the structured result, because matching on wording means an edit to that
 * wording silently turns "found nothing" into "found something" — and the
 * empty-seed prompt branch, which exists to stop this layer reporting false
 * absence, would stop firing.
 */
export function hasEvidence(evidence: string): boolean {
	const t = evidence.trim().toLowerCase();
	if (!t) return false;
	return !NO_EVIDENCE_PREFIXES.some((p) => t.startsWith(p));
}

/**
 * How many hits the caller may actually see, from a structured search result.
 *
 * NOT `total`: that counts what qmd returned BEFORE the exposure policy filtered
 * it, so a search whose every hit was withheld has `total > 0` and nothing to
 * show. The seed the spawn receives is the permitted set, so the permitted count
 * is what decides which prompt it gets.
 */
export function visibleHits(seed: { readonly total: number; readonly withheld: number }): number {
	return Math.max(0, seed.total - seed.withheld);
}

/** Cap on collected stdout, matching the ceiling `spawnSync`'s maxBuffer gave. */
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

/**
 * Read a finished run's output. PURE — no spawn, no clock, no filesystem.
 *
 * Split out because everything that decides how a run is REPORTED lives here,
 * including `ok`, which gates the "no answer, refused by name" path. While this
 * was inside the spawn it was the one decision in this module nothing could
 * exercise without starting a session. Same seam as `parseMemory` / `readMemoryFile`
 * and `digestsFrom` / `loadMemoryDigests`.
 */
export function interpretRun(
	stdout: string,
	stderr: string,
	spawnError: string | null,
	wallMs: number,
): ReasoningResult {
	const empty = (error: string): ReasoningResult => ({
		ok: false,
		answer: "",
		costUsd: 0,
		turns: 0,
		modelUsed: "",
		terminal: "spawn_failed",
		wallMs,
		error,
	});

	let j: Record<string, unknown>;
	try {
		j = JSON.parse(stdout) as Record<string, unknown>;
	} catch {
		// A non-JSON body means the CLI never got far enough to report. Whatever it
		// printed is the only diagnostic there is — and a spawn error outranks it,
		// since "ENOENT: claude" explains the empty output that follows.
		const why = String(stderr || stdout || "no output").slice(0, 300);
		return empty(spawnError ?? why);
	}
	// Valid JSON but the process still failed to launch cleanly: trust the error.
	if (spawnError) return empty(spawnError);

	const usage = (j.modelUsage ?? {}) as Record<string, unknown>;

	return {
		// `is_error` covers a run that stopped without concluding, which is the
		// outcome this must never present as a complete answer.
		ok: j.is_error !== true,
		answer: typeof j.result === "string" ? j.result : "",
		costUsd: typeof j.total_cost_usd === "number" ? j.total_cost_usd : 0,
		turns: typeof j.num_turns === "number" ? j.num_turns : 0,
		modelUsed: Object.keys(usage).join(",") || "unknown",
		terminal: typeof j.terminal_reason === "string" ? j.terminal_reason : "unknown",
		wallMs,
		error: null,
	};
}

/**
 * Run the spawn. The thin IO half; `interpretRun` decides what its output means.
 *
 * ASYNC, and that is load-bearing rather than stylistic. `spawnSync` holds the
 * whole event loop for the life of the child — measured at 73–76s, capped at
 * 300s — during which the server parses no stdin at all: no other tool call, no
 * `ping`, no `roots/list` reply, and no timers, so the identity gate's own 2s
 * cap could not fire either. The entry script pays for concurrency deliberately
 * ("serialising them here would make one slow search block every other call"),
 * and a synchronous spawn took that back harder than serialising would have.
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
	claude: { readonly cmd: string; readonly leading: readonly string[] },
	vaultRoot: string,
	cfg: ReasonConfig,
	prompt: string,
	mcpConfigPath: string,
): Promise<ReasoningResult> {
	const started = Date.now();
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(claude.cmd, [...claude.leading, ...reasoningArgs(cfg, prompt, mcpConfigPath)], {
				cwd: vaultRoot,
				// `timeout` + `killSignal` reproduce spawnSync's bound without holding
				// the loop: node kills the child itself when it overruns.
				timeout: SPAWN_TIMEOUT_MS,
				killSignal: "SIGKILL",
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (e) {
			resolve(interpretRun("", "", e instanceof Error ? e.message : String(e), Date.now() - started));
			return;
		}

		let out = "";
		let err = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (d: string) => {
			if (out.length < MAX_STDOUT_BYTES) out += d;
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (d: string) => {
			// Only ever used as a diagnostic string, so a small window is plenty.
			if (err.length < 4096) err += d;
		});

		let spawnError: string | null = null;
		child.on("error", (e: Error) => {
			spawnError = e.message;
		});
		// `close` rather than `exit`: it fires once the pipes are drained, so the
		// last chunk of a large answer is never lost to the race.
		child.on("close", () => {
			resolve(interpretRun(out, err, spawnError, Date.now() - started));
		});
	});
}

/** Human-readable refusal, so a caller learns what to change. */
export function describeRefusal(reason: string, detail: string): string {
	return `Not run: ${reason}\n\n${detail}`;
}

/** The npm package that ships the CLI, when it was installed that way. */
const CLI_PACKAGE = "@anthropic-ai/claude-code";

/**
 * Locate the CLI's real JS entry when it came from npm. Null when it did not.
 *
 * Reads the package's own `bin` rather than guessing a path, so a layout change
 * upstream degrades to null instead of to a wrong file.
 */
function resolveCliEntry(): string | null {
	try {
		const manifestPath = require.resolve(`${CLI_PACKAGE}/package.json`);
		const pkg = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			bin?: string | Record<string, string>;
		};
		const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.claude;
		if (!rel) return null;
		const entry = join(dirname(manifestPath), rel);
		return existsSync(entry) ? entry : null;
	} catch {
		return null;
	}
}

/**
 * How to invoke the CLI: the command plus any leading args.
 *
 * Three layers, in order.
 *
 * `OM_CLAUDE_BIN` first, because a user whose CLI is not on this process's PATH
 * has no other way to say so, and a spawn that cannot find its binary is
 * otherwise an opaque failure.
 *
 * Then the npm entry run through `process.execPath`, which is the same fix
 * `qmd.ts` carries and for the same reason: npm installs a CLI on Windows as a
 * `.cmd` shim, and Node refuses to spawn one without a shell. `reason` cannot
 * take the shell escape hatch that `buildQmdCommand` falls back to — the prompt
 * is a JSON-bearing argument and `cmd.exe` strips its quotes — so resolving the
 * real JS entry is the only portable route.
 *
 * Then the bare name, which is right for the native single-binary install and is
 * what this ran on before. A failed resolution therefore lands exactly where it
 * always did rather than somewhere new.
 */
export function resolveClaudeCommand(env: NodeJS.ProcessEnv = process.env): {
	readonly cmd: string;
	readonly leading: readonly string[];
} {
	const override = env.OM_CLAUDE_BIN;
	if (override && override.trim()) return { cmd: override.trim(), leading: [] };

	const entry = resolveCliEntry();
	if (entry) return { cmd: process.execPath, leading: [entry] };

	return { cmd: "claude", leading: [] };
}

/**
 * An MCP config declaring NO servers.
 *
 * Paired with `--strict-mcp-config` this is the recursion guard: the spawn
 * inherits no MCP at all, so it cannot reach back into this server and start a
 * loop that multiplies at every level. Verified — a spawn under these flags reports
 * no MCP servers available.
 *
 * It lives beside the audit log rather than in `REASONING_DIR`, because that
 * directory is user-facing — every answer names a record inside it — and is
 * otherwise a homogeneous set of timestamped transcripts. Runtime plumbing sits
 * with runtime plumbing so "list or prune my reasoning records" never needs a
 * filename exception.
 *
 * Rewritten on every call, deliberately: it is four syscalls against a spawn
 * measured in tens of seconds, and re-creating it means a user who deletes the
 * file mid-session gets a working next call instead of a mystery.
 */
export function writeIsolatedMcpConfigPath(vaultRoot: string): string {
	return join(vaultRoot, ".claude", "om-mcp-no-mcp.json");
}

export function writeIsolatedMcpConfig(vaultRoot: string): string {
	const path = writeIsolatedMcpConfigPath(vaultRoot);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ mcpServers: {} }), "utf8");
	return path;
}

/**
 * The record's text. PURE, so its shape is assertable without touching disk —
 * the same split `renderCapture`/`captureNote` and `renderMemory`/`writeMemory`
 * keep, and the reason neither of them needs a tmpdir to prove its frontmatter.
 */
export function renderReasoningRecord(now: Date, question: string, r: ReasoningResult): string {
	return [
		"---",
		`date: ${now.toISOString()}`,
		"source: mcp-reason",
		`cost_usd: ${r.costUsd}`,
		`turns: ${r.turns}`,
		`model: ${r.modelUsed}`,
		// Always inferred. A spawned conclusion is reasoning, not a verified fact,
		// and the epistemic contract exists to keep those apart.
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
	].join("\n");
}

/**
 * Persist the question, the answer and what it cost.
 *
 * Gitignored, beside the audit log: a spawned conclusion is INFERRED, so it does
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
		writeFileSync(full, renderReasoningRecord(now, question, r), "utf8");
		return rel;
	} catch {
		return null;
	}
}
