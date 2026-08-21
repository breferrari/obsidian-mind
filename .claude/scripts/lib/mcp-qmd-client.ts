/**
 * Tier 1 — search, served by acting as an MCP CLIENT of the vault's own qmd
 * server.
 *
 * The index covers the whole vault, including memories and any folder outside
 * the exposed roots. Results are matched against the served set AFTER
 * retrieval, so one place decides what comes back.
 *
 * That ordering is load-bearing. Filtering the QUERY would require every caller
 * to construct a scoped query correctly; filtering the RESULT means no query a
 * caller can write returns more than the policy serves.
 *
 * The spawn and the filter are deliberately separated: the filter is pure, so
 * its behaviour is provable without starting a process.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

/** One hit as qmd reports it in `structuredContent.results`. */
export interface QmdHit {
	readonly file?: string;
	readonly line?: number;
	readonly score?: number;
	readonly title?: string;
	readonly snippet?: string;
}

export interface ScopedResult {
	readonly text: string;
	/** How many hits the policy removed. Surfaced for the audit log. */
	readonly withheld: number;
	/** How many qmd returned before filtering. */
	readonly total: number;
}

// ---------------------------------------------------------------------------
// Path identity — the comparison the filter depends on
// ---------------------------------------------------------------------------

/**
 * Normalise a path for comparison.
 *
 * Spaces collapse to hyphens because qmd does the same when it indexes, so
 * `brain/Key Decisions.md` and `brain/Key-Decisions.md` are the same document
 * and must compare equal. Case folds because Windows.
 */
export function pathKey(s: unknown): string {
	return String(s ?? "")
		.replace(/\\/g, "/")
		.replace(/\s+/g, "-")
		.toLowerCase();
}

/**
 * A file's identity relative to the vault root.
 *
 * Matching is on the FULL relative path, never the basename: two notes sharing
 * a filename in different folders would otherwise alias, and one of them being
 * in scope would admit the other.
 */
export function vaultRelKey(vaultRoot: string, fullPath: string): string {
	const v = pathKey(vaultRoot).replace(/\/+$/, "");
	const p = pathKey(fullPath);
	return p.startsWith(v) ? p.slice(v.length).replace(/^\/+/, "") : p;
}

/** A word that marks a query as a question rather than a set of keywords. */
const QUESTION_SHAPED = /\b(why|how|what|when|where|which|who|should|can|does|did|is|are|was)\b|\?/i;

export interface SubQuery {
	readonly type: "lex" | "vec" | "hyde";
	readonly query: string;
}

/**
 * Build the typed sub-queries for one search.
 *
 * `lex` and `vec` always go out together: keywords find the exact term, vectors
 * find the note that answers the question without using the word.
 *
 * `hyde` is added only for question-shaped queries. It writes a hypothetical
 * answer and matches against that, which is what helps when someone asks "why
 * did we decide X" and the note is titled something else entirely. It is not
 * free — it runs a local generation model — so a two-word keyword lookup, where
 * lexical matching is already the right tool, does not pay for it.
 */
export function subQueries(query: string): SubQuery[] {
	const q = String(query).trim();
	const subs: SubQuery[] = [
		{ type: "lex", query: q },
		{ type: "vec", query: q },
	];
	if (q.split(/\s+/).length >= 4 && QUESTION_SHAPED.test(q)) subs.push({ type: "hyde", query: q });
	return subs;
}

/** qmd paths are collection-prefixed: `myvault/brain/Foo.md` → `brain/foo.md`. */
export function qmdRelKey(qmdPath: unknown): string {
	const p = pathKey(qmdPath);
	const i = p.indexOf("/");
	return i >= 0 ? p.slice(i + 1) : p;
}

// ---------------------------------------------------------------------------
// The filter — pure, and the reason this file is split
// ---------------------------------------------------------------------------

const SNIPPET_MAX = 700;
const RESPONSE_MAX = 6000;

/**
 * Filter and render qmd's results against the set of paths this vault serves.
 *
 * `allowed` is a set of vault-relative keys produced by `vaultRelKey`. A hit
 * whose key is not in it is dropped and counted — counted, because a silent
 * drop is indistinguishable from an empty index, and the caller needs to tell
 * "nothing matched" apart from "nothing in scope".
 */
export function scopeResults(
	structured: unknown,
	allowed: ReadonlySet<string>,
	limit = 5,
): ScopedResult {
	// No structured results means no per-hit paths to filter on. qmd's
	// human-readable summary carries note paths too, so returning that instead
	// would hand back results nothing ever matched against the policy.
	if (!Array.isArray(structured)) {
		return { text: "(search unavailable: results could not be scope-checked)", withheld: 0, total: 0 };
	}

	const hitsAll = structured as QmdHit[];
	const permitted = hitsAll.filter((h) => allowed.has(qmdRelKey(h.file)));
	const withheld = hitsAll.length - permitted.length;
	const hits = permitted.slice(0, Math.max(0, limit));

	if (!hits.length) {
		return {
			text: withheld
				? `(no results visible to this repo; ${withheld} match(es) withheld as out of scope)`
				: "(no results)",
			withheld,
			total: hitsAll.length,
		};
	}

	// `context` is dropped: qmd repeats an identical vault-level blurb on every
	// hit, and it was the single biggest consumer of the response budget.
	const body = hits
		.map((h, i) => {
			const snippet = String(h.snippet ?? "")
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, SNIPPET_MAX);
			const where = `${h.file}${h.line ? `:${h.line}` : ""}`;
			const score = Math.round((h.score ?? 0) * 100);
			return `[${i + 1}] ${where}  (score ${score}%)\n    ${h.title ?? ""}\n    ${snippet}`;
		})
		.join("\n\n")
		.slice(0, RESPONSE_MAX);

	const tail = withheld ? `\n\n(${withheld} further match(es) withheld: outside this repo's scope)` : "";
	return { text: body + tail, withheld, total: hitsAll.length };
}

// ---------------------------------------------------------------------------
// The client — impure
// ---------------------------------------------------------------------------

/** The budget for a call to a qmd that has already answered once. */
const CALL_TIMEOUT_MS = 45_000;

/**
 * The budget for the FIRST `tools/call` a child serves.
 *
 * qmd fetches its embedding and reranker models on first use — hundreds of MB
 * over the network — and does it lazily, inside the first query rather than at
 * startup. `initialize` returns in ~160ms regardless, so no readiness signal
 * this client can await says anything about it.
 *
 * On 2026-08-22, on a machine qmd had never run a query on, the reranker
 * (639MB) took ~70s to arrive. The flat 45s budget expired at 45.02s and the
 * caller was told the vault could not answer. The download is bounded by the
 * connection, not by us, so the only honest budget for that one call is a
 * generous one — a wait is recoverable, and the wrong conclusion it replaced
 * ("nothing is recorded") is not.
 *
 * Long is safe here for a reason that is easy to miss: a launcher that dies is
 * caught by `failAll` on the child's `error`/`exit`, not by this timer. Nothing
 * waits out this budget except a child that is alive and working.
 */
const COLD_CALL_TIMEOUT_MS = 10 * 60_000;

/** Which budget a call gets. Exported because the boundary is worth locking. */
export function callBudget(method: string, warmed: boolean): number {
	return method === "tools/call" && !warmed ? COLD_CALL_TIMEOUT_MS : CALL_TIMEOUT_MS;
}

/**
 * What a caller is told when a call runs out of budget.
 *
 * The cold case says what it is, because the previous message did not. The
 * documented response to a failed search is to call `health` and, if that is
 * clean, conclude the record is not there — so a bare `qmd timeout on
 * tools/call` does not merely under-inform, it actively argues for the wrong
 * conclusion. On 2026-08-22 the record existed and was complete.
 */
export function timeoutMessage(method: string, budgetMs: number, warmed: boolean): string {
	const secs = Math.round(budgetMs / 1000);
	if (method !== "tools/call" || warmed) return `qmd timeout on ${method} after ${secs}s`;
	return (
		`qmd timeout on ${method} after ${secs}s, on the first search this qmd process served. ` +
		"qmd downloads its embedding and reranker models on first use (hundreds of MB); that is the likely cause. " +
		"This says NOTHING about whether the vault holds the record — do not conclude it is missing. Retry."
	);
}

interface Pending {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
	timer: NodeJS.Timeout;
}

export interface QmdClient {
	call(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
	readonly ready: Promise<void>;
	dispose(): void;
	/**
	 * False once the child has exited or failed to start. The caller must not
	 * keep using a dead client: a memoised one would make a single qmd crash
	 * disable search for the whole life of the server.
	 */
	readonly alive: boolean;
	/**
	 * True once a `tools/call` has returned from this child, i.e. qmd's models
	 * are loaded and the next call is on the fast path.
	 */
	readonly warmed: boolean;
}

/**
 * Spawn the vault's own qmd launcher and speak MCP to it.
 *
 * Reusing the launcher rather than invoking qmd directly inherits two fixes for
 * free: the Windows `.cmd` shim workaround, and the named-index pin. Locating it
 * rather than hardcoding the path matters because #71 is actively moving hook
 * scripts, and a stale path here kills search silently.
 */
export function createQmdClient(vaultRoot: string, launcherPath: string | null): QmdClient {
	const launcher = launcherPath ?? join(vaultRoot, ".claude", "scripts", "qmd-mcp.mjs");
	const child: ChildProcess = spawn(process.execPath, [launcher], {
		stdio: ["pipe", "pipe", "ignore"],
		env: { ...process.env, CLAUDE_PROJECT_DIR: vaultRoot },
	});

	const pending = new Map<number, Pending>();
	let alive = true;
	// Whether any `tools/call` has come BACK from this child. False means the
	// next one may still be paying qmd's one-time model download.
	let warmed = false;
	let rpcId = 0;
	let buf = "";

	child.stdout?.on("data", (d: Buffer | string) => {
		buf += String(d);
		let nl: number;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line) continue;
			let msg: { id?: number; error?: { message?: string }; result?: unknown };
			try {
				msg = JSON.parse(line) as typeof msg;
			} catch {
				continue;
			}
			if (typeof msg.id !== "number") continue;
			const p = pending.get(msg.id);
			if (!p) continue;
			pending.delete(msg.id);
			clearTimeout(p.timer);
			if (msg.error) p.reject(new Error(msg.error.message ?? "qmd error"));
			else p.resolve(msg.result);
		}
	});

	// A launcher that dies (qmd not installed, bad path) must fail every waiting
	// call rather than leaving them to time out one by one 45 seconds apart.
	const failAll = (reason: string): void => {
		alive = false;
		for (const [id, p] of pending) {
			pending.delete(id);
			clearTimeout(p.timer);
			p.reject(new Error(reason));
		}
	};
	child.on("error", (e) => failAll(`qmd launcher failed: ${e.message}`));
	child.on("exit", () => failAll("qmd launcher exited"));

	const call = (method: string, params?: unknown, timeoutMs?: number): Promise<unknown> =>
		new Promise((resolve, reject) => {
			// A call made AFTER the child died would otherwise sit in `pending`
			// forever: failAll has already run, so nothing will ever reject it, and
			// the timeout timer is unref'd. Callers that skip `await ready` — the
			// semantic-ordering path does — would block until the timeout.
			if (!alive) {
				reject(new Error(`qmd unavailable (${method})`));
				return;
			}
			const id = ++rpcId;
			const budget = timeoutMs ?? callBudget(method, warmed);
			const timer = setTimeout(() => {
				if (pending.delete(id)) reject(new Error(timeoutMessage(method, budget, warmed)));
			}, budget);
			// Node keeps the process alive for a pending timer; this one must not
			// hold the server open on its own.
			timer.unref?.();
			pending.set(id, {
				// Warmth is recorded on the RESULT, not on the send: a `tools/call`
				// that is still in flight has not proved the models are loaded, and
				// marking it early would hand the short budget to a concurrent second
				// search that is queued behind the same download.
				resolve: (v) => {
					if (method === "tools/call") warmed = true;
					resolve(v);
				},
				reject,
				timer,
			});
			child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
		});

	const ready = call("initialize", {
		protocolVersion: "2025-11-25",
		capabilities: {},
		clientInfo: { name: "om", version: "0.1.0" },
	}).then(() => {
		child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
	});

	// `ready` rejects if the child dies during the handshake. Attaching a handler
	// here keeps that from surfacing as an UNHANDLED rejection, which Node treats
	// as fatal — so a qmd that failed to start would take the whole MCP server
	// down with it, when the correct behaviour is search degrading on its own.
	// Anyone who awaits `ready` still sees the rejection.
	ready.catch(() => {});

	return {
		call,
		ready,
		get alive() {
			return alive;
		},
		get warmed() {
			return warmed;
		},
		dispose: () => {
			failAll("qmd client disposed");
			child.kill();
		},
	};
}

/**
 * Run a hybrid search and return only what this caller may see.
 *
 * Both a lexical and a vector sub-query go out: keyword matching finds the exact
 * term, embeddings find the note that answers the question without using the
 * word. Sending one and not the other is how a search that "works" still misses
 * the note the user was thinking of.
 */
export async function qmdSearch(
	client: QmdClient,
	allowed: ReadonlySet<string>,
	query: string,
	limit = 5,
): Promise<ScopedResult> {
	try {
		await client.ready;
		const out = (await client.call("tools/call", {
			name: "query",
			arguments: {
				searches: subQueries(query),
				intent: query,
				// Over-fetch: the filter is applied to the RESULT, so asking for
				// exactly `limit` means a vault with much unexposed content returns
				// far fewer than requested with no sign that more existed.
				limit: Math.max(limit * 4, 20),
				minScore: 0.4,
			},
		})) as { structuredContent?: { results?: unknown } } | null;
		return scopeResults(out?.structuredContent?.results, allowed, limit);
	} catch (e) {
		// qmd is optional in this template. A failure degrades this ONE call and
		// says so; it must never present as "the vault is empty".
		const message = e instanceof Error ? e.message : String(e);
		return { text: `search failed: ${message}`, withheld: 0, total: 0 };
	}
}

// ---------------------------------------------------------------------------
// The probe — what `health` uses to prove search ANSWERS
// ---------------------------------------------------------------------------

/**
 * How long `health` waits for search to answer before calling it degraded.
 *
 * Two budgets, because the probe inherits whatever the client is carrying. A
 * warm client answers in ~31ms, so 5s is enormous headroom and `health` stays
 * instant. A cold one pays qmd's model load first, and that is not a small
 * number: measured at 2.9s with the models hot in the page cache and 10.5s with
 * them cold, against ~970MB of GGUF across two models.
 *
 * A single 20s budget was the first attempt and it was wrong — 10.5s of a 20s
 * budget is not headroom, and the failure mode it buys is the worst kind: a
 * DEGRADED verdict on a healthy vault, from the one tool a caller consults
 * precisely because they already suspect something is broken. Slow-and-correct
 * beats fast-and-wrong here every time; `health` is rare and diagnostic.
 */
const PROBE_TIMEOUT_WARM_MS = 5_000;
const PROBE_TIMEOUT_COLD_MS = 60_000;

/**
 * The probe's budget. Exported so the warm/cold split is pinned by a test
 * rather than by a comment.
 *
 * Still far below `COLD_CALL_TIMEOUT_MS`: a real search should wait out a model
 * download, a diagnostic should give up and REPORT. Timing out here is an
 * answer, not a failure.
 */
export function probeBudget(warmed: boolean): number {
	return warmed ? PROBE_TIMEOUT_WARM_MS : PROBE_TIMEOUT_COLD_MS;
}

export interface QmdProbe {
	readonly ok: boolean;
	readonly ms: number;
	/** One clause, written to be appended to "search ...". */
	readonly detail: string;
}

/**
 * Round-trip a real search and report whether it answered.
 *
 * `health` used to report `launcher found`, which is a check on a FILE EXISTING.
 * On 2026-08-22 that line read healthy while every search was timing out, on the
 * one tool whose entire purpose is telling apart the failure modes behind an
 * identical "no results" — so the instrument proved something other than what it
 * said. Nothing short of a round-trip closes that gap.
 *
 * The probe goes through `subQueries` and omits `rerank`, exactly as `qmdSearch`
 * does, so it pays the same model costs a real search pays. A cheaper probe —
 * lexical only, or `rerank: false` — would have passed happily on 2026-08-22
 * while the reranker download was still the thing blocking search, which is the
 * same defect in a new place.
 *
 * Its own SHORT budget, not the client's: `health` is what a caller runs when
 * something is already wrong, and a diagnostic that hangs for the cold-start
 * budget is not a diagnostic. Timing out here is a REPORT, not a failure — it
 * says search is not answering yet and names why that happens.
 */
export async function qmdProbe(client: QmdClient, timeoutMsOverride?: number): Promise<QmdProbe> {
	// Read BEFORE the await: `client.warmed` flips as soon as any call returns,
	// and a budget chosen after that would describe a state the probe did not
	// start in.
	const timeoutMs = timeoutMsOverride ?? probeBudget(client.warmed);
	const started = Date.now();
	try {
		await client.ready;
		const out = (await client.call(
			"tools/call",
			{
				name: "query",
				arguments: { searches: subQueries("vault"), intent: "health probe", limit: 1, minScore: 0.4 },
			},
			timeoutMs,
		)) as { structuredContent?: { results?: unknown } } | null;
		const ms = Date.now() - started;
		// Answering with no structured results is its own failure: `scopeResults`
		// cannot scope-check hits it cannot see, so search would return
		// "(search unavailable)" for every query while the transport looks fine.
		if (!Array.isArray(out?.structuredContent?.results)) {
			return { ok: false, ms, detail: `answered in ${ms}ms but returned no structured results — hits cannot be scope-checked` };
		}
		return { ok: true, ms, detail: `answered in ${ms}ms` };
	} catch (e) {
		const ms = Date.now() - started;
		const message = e instanceof Error ? e.message : String(e);
		// A probe timeout does not make the same claim a search timeout makes.
		// The probe's budget is short so `health` stays fast; search's is minutes.
		// Echoing the raw message here would publish "timeout after 20s" as if 20s
		// were what search allows, and someone would tune the wrong number.
		if (message.startsWith("qmd timeout")) {
			return {
				ok: false,
				ms,
				detail:
					`did not answer within ${Math.round(timeoutMs / 1000)}s — search is DEGRADED right now. ` +
					"qmd downloads its embedding and reranker models on first use (hundreds of MB); " +
					"on a vault new to this machine that is the likely cause, and it clears itself once the download lands. " +
					"A real search waits far longer than this probe does.",
			};
		}
		return { ok: false, ms, detail: `DID NOT ANSWER (${message})` };
	}
}
