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

const CALL_TIMEOUT_MS = 45_000;

interface Pending {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
	timer: NodeJS.Timeout;
}

export interface QmdClient {
	call(method: string, params?: unknown): Promise<unknown>;
	readonly ready: Promise<void>;
	dispose(): void;
	/**
	 * False once the child has exited or failed to start. The caller must not
	 * keep using a dead client: a memoised one would make a single qmd crash
	 * disable search for the whole life of the server.
	 */
	readonly alive: boolean;
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

	const call = (method: string, params?: unknown): Promise<unknown> =>
		new Promise((resolve, reject) => {
			// A call made AFTER the child died would otherwise sit in `pending`
			// forever: failAll has already run, so nothing will ever reject it, and
			// the timeout timer is unref'd. Callers that skip `await ready` — the
			// semantic-ordering path does — would block until the 45s timeout.
			if (!alive) {
				reject(new Error(`qmd unavailable (${method})`));
				return;
			}
			const id = ++rpcId;
			const timer = setTimeout(() => {
				if (pending.delete(id)) reject(new Error(`qmd timeout on ${method}`));
			}, CALL_TIMEOUT_MS);
			// Node keeps the process alive for a pending timer; this one must not
			// hold the server open on its own.
			timer.unref?.();
			pending.set(id, { resolve, reject, timer });
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
