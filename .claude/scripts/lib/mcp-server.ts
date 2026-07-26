/**
 * The wiring: MCP methods to vault behaviour.
 *
 * Kept out of the entry script so the whole surface can be driven in-process by
 * a test — the prototype's handlers were bound to module state and stdio, which
 * meant every behavioural claim needed a live client to check, and two bugs
 * survived precisely because checking was expensive.
 *
 * The consistent rule here: a tool that depends on WHO is calling waits for
 * identity first. Anything that answers before the roots handshake completes is
 * answering for an anonymous caller, and quietly returns the wrong scope rather
 * than an error.
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import type { VaultContext } from "./mcp-context.ts";
import { INSTRUCTIONS, PROMPTS } from "./mcp-context.ts";
import type { McpSession, Handlers } from "./mcp-protocol.ts";
import {
	type ExposurePolicy,
	visibleFiles,
	allowedSearchPaths,
	listResources,
	resolveResourceUri,
} from "./mcp-exposure.ts";
import { expandNote } from "./mcp-graph.ts";
import { qmdSearch, type QmdClient } from "./mcp-qmd-client.ts";
import { callerProject, isVaultItself } from "./mcp-caller.ts";
import { callerPlatforms, loadMemoryDigests, resolvableNames } from "./mcp-memory-bridge.ts";
import { captureNote } from "./mcp-capture.ts";
import { semanticMemoryOrder } from "./mcp-memory-bridge.ts";
import { TOOLS } from "./mcp-tools.ts";
import { recall, type MemoryEntry } from "./memory-recall.ts";
import { validateMemory, writeMemory, renderMemory, resolveLinks } from "./memory-write.ts";
import { findSimilar } from "./memory-similarity.ts";
import { markSuperseded, resolveSupersedes } from "./memory-supersede.ts";
import { health } from "./memory-discover.ts";
import { resolveQmdEntry, buildQmdCommand } from "./qmd.ts";

const PROTOCOL_VERSION = "2025-11-25";
const SERVER_NAME = "om";
const SERVER_VERSION = "0.1.0";
const DEFAULT_RECALL_LIMIT = 20;
const REINDEX_TIMEOUT_MS = 20_000;

export interface ServerDeps {
	readonly ctx: VaultContext;
	readonly policy: ExposurePolicy;
	readonly session: McpSession;
	/** Lazily created, because a vault with no qmd must still serve everything else. */
	readonly qmd: () => QmdClient;
	readonly audit: (action: string, detail?: Record<string, unknown>) => void;
	readonly reindex?: () => boolean;
	readonly now?: () => Date;
}

const text = (s: string): { content: { type: "text"; text: string }[] } => ({
	content: [{ type: "text", text: s }],
});

/**
 * Re-index after a write, synchronously and bounded.
 *
 * The vault normally re-indexes from a PostToolUse hook, but an MCP write is
 * not a Claude Code tool call, so no hook fires. Verified: a captured memory sat
 * on disk and `search` could not find it.
 *
 * That matters more than it looks. The entire point of capture is that the
 * vault can retrieve the memory afterwards, and a note that exists but is
 * unfindable is strictly WORSE than no note — because it looks like the system
 * worked. Synchronous on purpose: reporting "recorded" before the memory is
 * retrievable is a lie the caller cannot detect. Bounded so a broken index
 * degrades to a warning rather than hanging the tool.
 */
export function reindexSync(indexName: string | null): boolean {
	try {
		const entry = resolveQmdEntry();
		const args = indexName ? ["--index", indexName, "update"] : ["update"];
		const { cmd, args: argv, shell } = buildQmdCommand(entry, args);
		const r = spawnSync(cmd, [...argv], { shell, timeout: REINDEX_TIMEOUT_MS, stdio: "ignore" });
		return r.status === 0;
	} catch {
		return false;
	}
}

export function createHandlers(deps: ServerDeps): Handlers {
	const { ctx, policy, session, qmd, audit } = deps;
	const now = deps.now ?? (() => new Date());
	const reindex = deps.reindex ?? (() => reindexSync(ctx.qmdIndex));

	/** Who is asking, as the memory layer understands it. */
	const caller = () => ({
		project: callerProject(session.roots),
		platforms: callerPlatforms(ctx.vaultRoot, callerProject(session.roots), ctx.memoryRoot),
	});

	// -----------------------------------------------------------------------
	// Tools
	// -----------------------------------------------------------------------

	async function callSearch(args: Record<string, unknown>): Promise<string> {
		const query = String(args.query ?? "");
		if (!query.trim()) return "(search needs a query)";
		const limit = Number(args.limit ?? 5);
		const allowed = allowedSearchPaths(ctx.vaultRoot, policy);
		const r = await qmdSearch(qmd(), allowed, query, limit);
		audit("search", { query, withheld: r.withheld, total: r.total, bytes: r.text.length });
		return r.text;
	}

	function callExpand(args: Record<string, unknown>): string {
		const seed = String(args.note ?? "");
		const r = expandNote(visibleFiles(ctx.vaultRoot, policy), seed);
		audit("expand", { note: seed, found: r.note !== null, hidden: r.hiddenOutbound });
		return r.text;
	}

	async function callRecall(args: Record<string, unknown>): Promise<string> {
		const who = caller();
		const limit = Number(args.limit ?? DEFAULT_RECALL_LIMIT);
		const explain = args.explain === true;
		const query = String(args.query ?? "").trim();

		const result = explain
			? recall(ctx.vaultRoot, who, { root: ctx.memoryRoot, explain: true })
			: { visible: recall(ctx.vaultRoot, who, { root: ctx.memoryRoot }), withheld: [] as MemoryEntry[] };

		let visible = result.visible;

		// Semantic ordering, applied to what visibility ALREADY allowed. A null
		// result means the index could not help, so the declared order stands —
		// worse ordering, never "the vault knows nothing".
		if (query && visible.length > 1) {
			const ordered = await semanticMemoryOrder(qmd(), ctx.vaultRoot, query, visible, limit);
			if (ordered) visible = ordered;
			else {
				// Lexical fallback: match against title AND body, per token. An
				// earlier version tested the whole query as one substring, which
				// found nothing whenever the caller phrased it as a question.
				const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
				const scored = visible
					.map((m) => {
						const hay = `${m.title ?? ""} ${m.body}`.toLowerCase();
						return { m, hits: terms.filter((t) => hay.includes(t)).length };
					})
					.filter((x) => x.hits > 0)
					.sort((a, b) => b.hits - a.hits);
				if (scored.length) visible = scored.map((x) => x.m);
			}
		}

		const shown = visible.slice(0, Math.max(0, limit));
		audit("recall", { query: query || null, returned: shown.length, project: who.project });

		if (!shown.length) {
			const why = who.project
				? `No memories are scoped to reach "${who.project}".`
				: "This session has no identity (no MCP roots), so only general-scope memories are visible — and there are none.";
			return `${why} Call health if you expected something here.`;
		}

		const lines = shown.map((m) => {
			const facets = [
				m.facets.confidence,
				m.facets.projects.length ? `projects: ${m.facets.projects.join(", ")}` : null,
				m.facets.platforms.length ? `platforms: ${m.facets.platforms.join(", ")}` : null,
				m.facets.date ? `as of ${m.facets.date}` : null,
				m.facets.superseded_by.length ? `SUPERSEDED by ${m.facets.superseded_by.join("; ")}` : null,
				m.why ? `why: ${m.why}` : null,
			].filter(Boolean);
			return `## ${m.title ?? "(untitled)"}\n${m.rel}\n(${facets.join(" · ")})\n\n${m.body}`;
		});

		if (explain && result.withheld.length) {
			// Counts and reasons only. Naming a withheld memory would disclose
			// exactly what the scope rule exists to hide.
			lines.push(
				`\n---\n${result.withheld.length} memor${result.withheld.length === 1 ? "y" : "ies"} withheld. ` +
					`Reasons: ${[...new Set(result.withheld.map((w) => w.why ?? "out of scope"))].join("; ")}`,
			);
		}
		return lines.join("\n\n---\n\n");
	}

	function callRemember(args: Record<string, unknown>): string {
		// The vault does not write to its own memory layer. A session inside the
		// vault already reads every note directly, and a memory written there
		// would be scoped to the vault-as-a-project — reaching only sessions that
		// by definition did not need it. Write-only by construction.
		if (isVaultItself(ctx.vaultRoot, session.roots)) {
			return [
				"Refused: this session is running inside the vault itself.",
				"",
				"Memories exist so a session that CANNOT see the vault can reach its knowledge.",
				"A memory recorded from here would be scoped to the vault as a project and would",
				"reach only sessions that already read every note directly. Write the note into",
				"the vault normally instead — the vault's own hooks will file and link it.",
			].join("\n");
		}

		const who = caller();
		const v = validateMemory(args, { now: now(), origin: who.project });
		if (!v.ok || !v.value) {
			return `Refused:\n${v.errors.map((e) => `- ${e}`).join("\n")}`;
		}

		const digests = loadMemoryDigests(ctx.vaultRoot, ctx.memoryRoot);

		// Near-duplicate suppression, facet-gated so two projects can each hold
		// their own copy of the same lesson.
		if (args.force !== true) {
			const { duplicates } = findSimilar(v.value, digests);
			if (duplicates.length) {
				const d = duplicates[0]!;
				return [
					`Not recorded: a near-identical memory already exists (${Math.round(d.score * 100)}% similar).`,
					`  ${d.entry.title}`,
					`  ${d.entry.rel}`,
					"",
					"If this genuinely differs, pass force: true. If it CORRECTS that memory,",
					"pass supersedes: [\"<its exact title>\"] instead — the old one is kept and back-linked.",
				].join("\n");
			}
		}

		const { resolved, dropped } = resolveLinks(args.links, resolvableNames(visibleFiles(ctx.vaultRoot, policy)));
		const supers = resolveSupersedes(args.supersedes, digests);

		if (args.dry_run === true) {
			return [
				"Preview (nothing written):",
				"",
				renderMemory(v.value, resolved),
				...(dropped.length ? ["", `Links dropped as unresolvable: ${dropped.join(", ")}`] : []),
				...(supers.unmatched.length ? [`Supersedes not matched: ${supers.unmatched.join(", ")}`] : []),
				...(v.warnings.length ? ["", "Warnings:", ...v.warnings.map((w) => `- ${w}`)] : []),
			].join("\n");
		}

		const written = writeMemory(ctx.vaultRoot, v.value, resolved, { root: ctx.memoryRoot });

		const retired: string[] = [];
		for (const m of supers.matched) {
			if (markSuperseded(ctx.vaultRoot, m.rel, v.value.title).ok) retired.push(m.title);
		}

		const indexed = reindex();
		audit("remember", { rel: written.rel, scope: v.value.scope, projects: v.value.projects, indexed });

		return [
			`Recorded: ${written.rel}`,
			`Scope: ${v.value.scope}${v.value.projects.length ? ` → ${v.value.projects.join(", ")}` : ""}`,
			...(retired.length ? [`Superseded: ${retired.join("; ")} (kept and back-linked)`] : []),
			...(supers.unmatched.length ? [`Supersedes NOT matched: ${supers.unmatched.join(", ")}`] : []),
			...(dropped.length ? [`Links dropped as unresolvable: ${dropped.join(", ")}`] : []),
			...(v.warnings.length ? ["", "Warnings:", ...v.warnings.map((w) => `- ${w}`)] : []),
			...(indexed ? [] : ["", "NOTE: the search index could not be refreshed, so this memory may not be findable by query yet."]),
		].join("\n");
	}

	function callRecordWork(args: Record<string, unknown>): string {
		const who = callerProject(session.roots);
		const resolvable = resolvableNames(visibleFiles(ctx.vaultRoot, policy));
		let r;
		try {
			r = captureNote(ctx.vaultRoot, policy, ctx.manifest, who, args, resolvable, {
				now: now(),
				reindex,
			});
		} catch (e) {
			// A refusal is the expected outcome for a bad folder, so it is reported
			// as a message rather than thrown — the caller can correct and retry,
			// which a protocol-level error makes harder.
			return `Not recorded: ${e instanceof Error ? e.message : String(e)}`;
		}

		if (!r.written) {
			return [`Preview (nothing written) → ${r.path}`, `Routing: ${r.routed}`, "", r.preview ?? ""].join("\n");
		}
		audit("record_work", { path: r.path, routed: r.routed, indexed: r.indexed });
		return [
			`Recorded: ${r.path}`,
			`Routing: ${r.routed}`,
			...(r.indexed === false
				? ["", "NOTE: the search index could not be refreshed, so this note may not be findable by query yet."]
				: []),
		].join("\n");
	}

	function callHealth(): string {
		const who = caller();
		const names = new Set(visibleFiles(ctx.vaultRoot, policy).map((f) => f.label));
		if (who.project) names.add(who.project);
		const h = health(ctx.vaultRoot, ctx.manifest, {
			knownNames: names,
			indexName: ctx.qmdIndex,
			home: process.env.HOME ?? process.env.USERPROFILE ?? null,
		});

		return [
			`Caller: ${who.project ?? "ANONYMOUS (no MCP roots — only general-scope memories are visible)"}`,
			`Platforms: ${who.platforms.length ? who.platforms.join(", ") : "(none declared)"}`,
			`Memory root: ${h.memory.root}/ (${h.memory.memories} memor${h.memory.memories === 1 ? "y" : "ies"}, ${h.memory.source})`,
			`Exposed roots: ${policy.roots.join(", ") || "(none)"} [${policy.source}]`,
			`Search index: ${ctx.qmdIndex ?? "(qmd default)"} · launcher ${ctx.qmdLauncher ? "found" : "NOT FOUND"}`,
			"",
			h.warnings.length ? `Warnings:\n${h.warnings.map((w) => `- ${w}`).join("\n")}` : "No warnings.",
			...(h.notes.length ? ["", `Notes:\n${h.notes.map((n) => `- ${n}`).join("\n")}`] : []),
		].join("\n");
	}

	// -----------------------------------------------------------------------
	// Dispatch
	// -----------------------------------------------------------------------

	return {
		initialize: (id, params) =>
			session.ok(id, {
				protocolVersion: (params as { protocolVersion?: string } | undefined)?.protocolVersion ?? PROTOCOL_VERSION,
				// listChanged on resources is load-bearing: the scoped list cannot be
				// computed until roots/list comes back, which is after the client's
				// first resources/list.
				capabilities: { tools: {}, resources: { listChanged: true }, prompts: {} },
				serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
				instructions: INSTRUCTIONS,
			}),

		ping: (id) => session.ok(id, {}),

		"tools/list": (id) => session.ok(id, { tools: TOOLS }),

		"tools/call": async (id, params) => {
			// Every tool below is scope-dependent. Answering before identity
			// resolves silently serves the anonymous view.
			await session.identityReady();
			const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
			const args = p.arguments ?? {};
			switch (p.name) {
				case "search":
					return session.ok(id, text(await callSearch(args)));
				case "expand":
					return session.ok(id, text(callExpand(args)));
				case "recall":
					return session.ok(id, text(await callRecall(args)));
				case "remember":
					return session.ok(id, text(callRemember(args)));
				case "record_work":
					return session.ok(id, text(callRecordWork(args)));
				case "health":
					return session.ok(id, text(callHealth()));
				default:
					return session.fail(id, `unknown tool ${p.name}`, -32602);
			}
		},

		"resources/list": async (id) => {
			await session.identityReady();
			session.ok(id, { resources: listResources(ctx.vaultRoot, policy) });
		},

		"resources/read": async (id, params) => {
			await session.identityReady();
			const uri = String((params as { uri?: unknown } | undefined)?.uri ?? "");
			const full = resolveResourceUri(ctx.vaultRoot, policy, uri);
			if (!full) {
				// Not-found rather than forbidden: the existence of a withheld note
				// is itself something the fence is hiding.
				audit("resource_denied", { uri });
				return session.fail(id, `no such resource: ${uri}`, -32602);
			}
			audit("resource_read", { uri });
			session.ok(id, { contents: [{ uri, mimeType: "text/markdown", text: readFileSync(full, "utf8") }] });
		},

		"prompts/list": (id) => session.ok(id, { prompts: PROMPTS }),

		"prompts/get": (id, params) => {
			const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
			const prompt = PROMPTS.find((x) => x.name === p.name);
			if (!prompt) return session.fail(id, `no prompt ${p.name}`, -32602);
			const arg = String(p.arguments?.[prompt.arguments[0]!.name] ?? "");
			const instruction =
				prompt.name === "prior_art"
					? `Search the vault for prior decisions bearing on: "${arg}". Use the search tool, then recall. Report what was already decided, cite note paths, and say plainly if nothing was found rather than inferring an answer.`
					: `Search the vault for what is already known about: "${arg}". Use the search tool, then expand from the most relevant note. Summarise with citations, preserving any (TBC)/(inferred) markers and "as of" dates you find.`;
			session.ok(id, {
				description: prompt.description,
				messages: [{ role: "user", content: { type: "text", text: instruction } }],
			});
		},
	};
}
