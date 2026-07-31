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

import { readFileSync, realpathSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

import type { VaultContext } from "./mcp-context.ts";
import { INSTRUCTIONS, PROMPTS } from "./mcp-context.ts";
import type { McpSession, Handlers } from "./mcp-protocol.ts";
import {
	type ExposurePolicy,
	visibleFiles,
	allowedSearchPaths,
	listResources,
	resolveResourceUri,
	vaultRelKeyRaw,
} from "./mcp-exposure.ts";
import { expandNote } from "./mcp-graph.ts";
import { qmdSearch, type QmdClient } from "./mcp-qmd-client.ts";
import { callerProject, callerProjectSource, isVaultItself, PROJECT_MARKER, sumAuditField, sanitize } from "./mcp-caller.ts";
import { callerPlatforms, digestsFrom, resolvableNames } from "./mcp-memory-bridge.ts";
import { captureNote, findToolMarkup } from "./mcp-capture.ts";
import { semanticMemoryOrder } from "./mcp-memory-bridge.ts";
import { TOOLS } from "./mcp-tools.ts";
import { recallFrom, readMemories, type MemoryEntry } from "./memory-recall.ts";
import {
	resolvePromotedRef,
	auditPromotions,
	type PromotedResolution,
	type NoteCache,
} from "./memory-promoted.ts";
import { createMemoryIndex } from "./memory-index.ts";
import { validateMemory, writeMemory, renderMemory, resolveLinks, neutralizeWikilinks } from "./memory-write.ts";
import { findSimilar } from "./memory-similarity.ts";
import { markSuperseded, resolveSupersedes } from "./memory-supersede.ts";
import { health } from "./memory-discover.ts";
import { resolveQmdEntry, buildQmdCommand } from "./qmd.ts";
import {
	resolveReasonConfig,
	reasonUsage,
	reasonAuditDetail,
	runReasoning,
	reasoningPrompt,
	visibleHits,
	resolveClaudeCommand,
	writeIsolatedMcpConfig,
	writeReasoningRecord,
	describeRefusal,
	REASON_ACTION,
} from "./mcp-reason.ts";

const PROTOCOL_VERSION = "2025-11-25";
const SERVER_NAME = "om";
const SERVER_VERSION = "0.1.0";
const DEFAULT_RECALL_LIMIT = 20;
const REINDEX_TIMEOUT_MS = 20_000;
/** How many search hits seed a reasoning spawn. */
const REASON_SEED_HITS = 6;

export interface ServerDeps {
	readonly ctx: VaultContext;
	readonly policy: ExposurePolicy;
	readonly session: McpSession;
	/** Lazily created, because a vault with no qmd must still serve everything else. */
	readonly qmd: () => QmdClient;
	readonly audit: (action: string, detail?: Record<string, unknown>) => void;
	readonly reindex?: () => boolean;
	readonly now?: () => Date;
	/**
	 * Injectable for the same reason `reindex` and `now` are: without it, every
	 * `reason` outcome except the empty-question refusal needs a real spawn to
	 * reach, so the refusal paths — including "no answer, never a partial one",
	 * which is this tool's headline behaviour — could not be asserted at all.
	 */
	readonly runReason?: typeof runReasoning;
}

const text = (s: string): { content: { type: "text"; text: string }[] } => ({
	content: [{ type: "text", text: s }],
});

/**
 * Re-index after a write.
 *
 * The vault normally re-indexes from a PostToolUse hook, but an MCP write is not
 * a Claude Code tool call, so no hook fires — without this a note sits on disk
 * and cannot be found, which is worse than no note because it looks like the
 * system worked.
 *
 * Split by what each step guarantees: `update` decides whether the note is
 * retrievable at all and is synchronous and bounded; `embed` only decides where
 * it ranks and is detached, because it runs a local model.
 */
export function reindexSync(indexName: string | null): boolean {
	const run = (sub: string): boolean => {
		try {
			const entry = resolveQmdEntry();
			const args = indexName ? ["--index", indexName, sub] : [sub];
			const { cmd, args: argv, shell } = buildQmdCommand(entry, args);
			const r = spawnSync(cmd, [...argv], { shell, timeout: REINDEX_TIMEOUT_MS, stdio: "ignore" });
			return r.status === 0;
		} catch {
			return false;
		}
	};

	// `update` indexes the text and is what makes the note retrievable at all, so
	// it is synchronous: reporting "recorded" before that is a lie the caller
	// cannot detect.
	const indexed = run("update");
	if (!indexed) return false;

	// `embed` builds the vector and is DETACHED, because it affects only where a
	// memory RANKS, never whether it is found — recall appends everything the
	// index did not match in declared order, and a new memory sorts to the front
	// of that group. Waiting on a local model run for ordering that corrects
	// itself moments later buys nothing: measured, it was most of the write.
	try {
		const entry = resolveQmdEntry();
		const args = indexName ? ["--index", indexName, "embed"] : ["embed"];
		const { cmd, args: argv, shell } = buildQmdCommand(entry, args);
		spawn(cmd, [...argv], { shell, detached: true, stdio: "ignore" }).unref();
	} catch {
		/* ranking quality is best-effort; retrieval already works without it */
	}
	return true;
}

/** How many promoted entries the audit line names before it summarises. */
const AUDIT_PROMOTED_CAP = 25;
/** How long any single frontmatter-derived string may be in the audit line. */
const AUDIT_FIELD_CHARS = 300;

/** A frontmatter-derived value, bounded for the audit log. */
const auditField = (s: string): string =>
	s.length <= AUDIT_FIELD_CHARS ? s : `${s.slice(0, AUDIT_FIELD_CHARS)}…[${s.length}]`;

/**
 * How a promotion reads on the facet line.
 *
 * Each status says something different to a caller deciding whether to trust
 * the body above it, so they are worded apart rather than collapsed into one
 * "promoted" flag: served means you are reading the corrected text, and the
 * other four mean you are not, for reasons that differ in whether anyone can
 * do anything about them.
 */
function promotedFacet(p: PromotedResolution): string {
	switch (p.status) {
		case "served":
			// A block is addressed `#^id` and a heading `#Text`. Assuming the block
			// form handed a heading promotion back as `Note.md#^Some Heading`, which
			// is not a reference the caller can paste anywhere.
			return `promoted text from ${p.note}#${p.kind === "block" ? "^" : ""}${p.anchor}${
				p.truncated ? " (TRUNCATED to the served cap)" : ""
			}`;
		case "no-anchor":
			return `promoted to ${p.note} (no anchor; capture body shown)`;
		case "stale-anchor":
			return `promoted to ${p.note}, anchor ${p.kind === "block" ? "^" : ""}${p.anchor} STALE (capture body shown)`;
		case "not-exposed":
			return `promoted to ${p.note}, outside the exposed roots (capture body shown)`;
		case "unreadable":
			return `promoted to ${p.note}, unreadable (capture body shown)`;
	}
}

export function createHandlers(deps: ServerDeps): Handlers {
	const { ctx, policy, session, qmd, audit } = deps;
	const now = deps.now ?? (() => new Date());
	const reindex = deps.reindex ?? (() => reindexSync(ctx.qmdIndex));
	const runReason = deps.runReason ?? runReasoning;
	// One cache per server, living exactly as long as the process that owns it.
	const memoryIndex = createMemoryIndex(ctx.vaultRoot, ctx.memoryRoot);

	// The vault root with symlinks resolved, computed once.
	//
	// Needed because `resolveResourceUri` returns a REALPATH, and on macOS the
	// temp and home trees are reached through symlinks (`/var` is `/private/var`).
	// Stripping a realpath prefix with the unresolved root silently fails to match,
	// and `vaultRelKeyRaw` then returns its input unchanged — which is how an
	// absolute filesystem path ended up inside a `vault://note/...` URI. Caught by
	// macOS CI; invisible on Linux and Windows.
	const vaultReal = (() => {
		try {
			return realpathSync(ctx.vaultRoot);
		} catch {
			return ctx.vaultRoot;
		}
	})();

	/**
	 * The store, parsed, for READ paths. Lists and stats every file on every
	 * call; only the re-parse of an unchanged file is skipped.
	 */
	const storeEntries = (): MemoryEntry[] => memoryIndex.all();

	/**
	 * The store, read fresh from disk. For the duplicate scan ONLY.
	 *
	 * The cache validates with size + mtime, which is not a content hash. Any
	 * writer that sets mtime explicitly — rsync, tar, unzip, a sync client, a
	 * restored file version — produces same-size, same-mtime, different-bytes;
	 * so does a second-granularity filesystem. Measured on NTFS, 356 of 400
	 * back-to-back same-size rewrites carried an identical mtimeMs.
	 *
	 * That is survivable on recall, where the cost is stale ordering. It is not
	 * survivable here: a duplicate admitted by a stale view is permanent, because
	 * nothing downstream ever re-checks. The explicit `invalidate()` after a write
	 * does not save this either — it is per-process, and the deployment shape is
	 * one server per consuming repo, all writing into one vault.
	 *
	 * So the filesystem stays authoritative for the correctness-critical read, at
	 * the price of one uncached pass per write.
	 */
	const storeFresh = (): MemoryEntry[] => readMemories(ctx.vaultRoot, ctx.memoryRoot);

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

		const entries = storeEntries();
		const result = explain
			? recallFrom(entries, who, { explain: true })
			: { visible: recallFrom(entries, who), withheld: [] as MemoryEntry[] };

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

			// Relevance decides the order WITHIN each group, but a superseded
			// memory never outranks a live one. Reordering by relevance alone puts
			// a corrected-away fact above the correction that replaced it, which is
			// the one thing supersession exists to prevent.
			const live = visible.filter((m) => m.facets.superseded_by.length === 0);
			const retired = visible.filter((m) => m.facets.superseded_by.length > 0);
			visible = [...live, ...retired];
		}

		const shown = visible.slice(0, Math.max(0, limit));

		// Resolved BEFORE the audit line, because this is the only surface that
		// reads outside its own root, and the audit log is the STATED mitigation
		// for the exposure list not being a security boundary. "What did that
		// session actually see" has to stay answerable, and a recall that served
		// a `brain/` block while logging only a count does not answer it.
		//
		// One note cache per response, so twenty entries promoted into the same
		// topic note read it once. The map dies with the call, so a correction
		// made between two recalls is never served stale.
		const noteCache: NoteCache = new Map();
		const rows = shown.map((m) => {
			const promo = resolvePromotedRef(ctx.vaultRoot, policy, m.facets.promoted, noteCache);
			// A marker that exists but does not PARSE — a stray control character,
			// say — resolves to null, which would otherwise render as "not promoted
			// at all". Refusing to echo the string is right; refusing to mention
			// that a corrected version exists is not.
			//
			// Computed from `promo` rather than by calling again. The second call
			// looked free because the note cache is shared, but the cache holds
			// LINES: the fence mask and the line scan are per call, and
			// `resolveExposedNote` is not cached at all, so every promoted row paid
			// a second realpath and a second `isPrivate` read. Measured at 25 rows
			// over a 20k-line note: 1.27ms/row became 2.25ms/row.
			return { m, promo, unparsed: m.facets.promotedRaw !== null && promo === null };
		});
		const promotions = rows.map((r) => r.promo).filter((p): p is PromotedResolution => p !== null);

		audit("recall", {
			query: query || null,
			returned: shown.length,
			project: who.project,
			// Only when something was promoted, so an ordinary recall's audit line
			// keeps its existing shape and stays greppable.
			// Bounded, because the note path comes from frontmatter and the audit
			// log is rotated by SIZE. A megabyte-long marker produced a megabyte
			// audit entry, so ~10 such recalls would discard the history that is
			// this design's stated mitigation — the log would erase its own
			// evidence on the calls most worth having evidence of.
			...(promotions.length
				? {
						promoted: promotions.slice(0, AUDIT_PROMOTED_CAP).map((p) =>
							p.status === "served"
								? { note: auditField(p.note), anchor: auditField(p.anchor), kind: p.kind, status: p.status }
								: { note: auditField(p.note), status: p.status },
						),
						...(promotions.length > AUDIT_PROMOTED_CAP ? { promoted_omitted: promotions.length - AUDIT_PROMOTED_CAP } : {}),
					}
				: {}),
		});

		if (!shown.length) {
			const why = who.project
				? `No memories are scoped to reach "${who.project}".`
				: "This session has no identity (no MCP roots), so only general-scope memories are visible — and there are none.";
			return `${why} Call health if you expected something here.`;
		}

		const lines = rows.map(({ m, promo, unparsed }) => {
			const facets = [
				m.facets.confidence,
				m.facets.projects.length ? `projects: ${m.facets.projects.join(", ")}` : null,
				m.facets.platforms.length ? `platforms: ${m.facets.platforms.join(", ")}` : null,
				m.facets.date ? `as of ${m.facets.date}` : null,
				m.facets.superseded_by.length ? `SUPERSEDED by ${m.facets.superseded_by.join("; ")}` : null,
				// Named per entry rather than only in the footer, because a caller
				// quoting one memory out of five needs to know THIS one has a
				// corrected twin — a footer applies to the response, not to the line
				// being copied.
				promo ? promotedFacet(promo) : unparsed ? "promoted, but the marker is unreadable (capture body shown)" : null,
				m.why ? `why: ${m.why}` : null,
			].filter(Boolean);

			// The promoted text REPLACES the capture body when it is servable,
			// rather than joining it. Printing both would make the caller arbitrate
			// between two versions of one lesson, which is the judgement this whole
			// mechanism exists to make on their behalf.
			const source = promo?.status === "served" ? promo.text : m.body;

			// Body headings are demoted so the only `##` lines in the response are
			// entry titles. A memory body legitimately contains its own `## How
			// this is known`, and rendered at the same level it reads as a separate
			// memory titled that — the reader cannot tell where one entry ends.
			const body = source.replace(/^(#{1,4})\s/gm, (_, h: string) => `${"#".repeat(Math.min(h.length + 3, 6))} `);
			return `## ${m.title ?? "(untitled)"}\n${m.rel}\n(${facets.join(" · ")})\n\n${body}`;
		});

		// Said once, at the bottom, and only about what could NOT be served.
		//
		// An entry whose promoted text was served needs no warning: the caller is
		// already reading the corrected version, and the facet line says so. What
		// still costs the reader something is the remainder — a bare marker, a
		// stale anchor, a target outside the exposed roots — where the body above
		// is the capture as first written and a correction exists that this
		// surface cannot reach.
		const unserved = promotions.filter((p) => p.status !== "served");
		if (unserved.length) {
			const reasons = [...new Set(unserved.map((p) => p.status))].join(", ");
			lines.push(
				`\n---\n${unserved.length} of these ${unserved.length === 1 ? "has" : "have"} been promoted into the vault's ` +
					`\`brain/\` notes but could not be served here (${reasons}); the note is named on the entry. ` +
					`**The promoted note wins on any conflict** — it is the corrected, correction-swept version, and what you ` +
					`are reading is the capture as first written. Ask a vault session, or request the note by path, before ` +
					`relying on a detail that looks wrong.`,
			);
		}

		if (explain && result.withheld.length) {
			// Counts and reasons only. Naming a withheld memory would put another
			// project's material into this caller's context — the noise the scope
			// rule exists to remove.
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

		// Same refusal as `record_work`, and it matters MORE here. A corrupted work
		// note damages one project's record; a corrupted memory is served to every
		// other repo through `recall`, so the damage travels. Checked before
		// wikilink neutralisation, because a field that has swallowed the following
		// field is not text worth cleaning up.
		const corruptedMemory = findToolMarkup(args);
		if (corruptedMemory) {
			return [
				`Refused: the "${corruptedMemory}" field contains tool-call markup, so this call's arguments did not serialize correctly.`,
				"",
				"Nothing was written. Re-send with each field as plain prose, and check that",
				"a long list field was not folded into the preceding string.",
			].join("\n");
		}

		const who = caller();
		const resolvable = resolvableNames(visibleFiles(ctx.vaultRoot, policy));

		// Neutralise dangling wikilinks in the TITLE and BODY before validation, so
		// what is checked is what will be written. An agent in another repo writing
		// `[[Some Note]]` would otherwise turn the vault's own wikilink gate red.
		// The title matters as much as the body and was missed first time round:
		// it becomes the H1 *and* the filename, so a dangling link there is both a
		// broken edge and a file called `... [[Ghost Link]].md`.
		const titleLinks = neutralizeWikilinks((args as { title?: unknown }).title, resolvable);
		const bodyLinks = neutralizeWikilinks((args as { body?: unknown }).body, resolvable);
		const unlinked = [...new Set([...titleLinks.dropped, ...bodyLinks.dropped])];
		const v = validateMemory(
			{ ...args, title: titleLinks.text, body: bodyLinks.text },
			{ now: now(), origin: who.project },
		);
		if (!v.ok || !v.value) {
			return `Refused:\n${v.errors.map((e) => `- ${e}`).join("\n")}`;
		}

		const digests = digestsFrom(storeFresh());

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

		const { resolved, dropped } = resolveLinks(args.links, resolvable);
		const supers = resolveSupersedes(args.supersedes, digests);

		if (args.dry_run === true) {
			return [
				"Preview (nothing written):",
				"",
				renderMemory(v.value, resolved),
				...(dropped.length ? ["", `Links dropped as unresolvable: ${dropped.join(", ")}`] : []),
				...(unlinked.length ? [`Dangling wikilinks were unlinked: ${unlinked.join(", ")}`] : []),
				...(supers.unmatched.length ? [`Supersedes not matched: ${supers.unmatched.join(", ")}`] : []),
				...(v.warnings.length ? ["", "Warnings:", ...v.warnings.map((w) => `- ${w}`)] : []),
			].join("\n");
		}

		const written = writeMemory(ctx.vaultRoot, v.value, resolved, { root: ctx.memoryRoot });
		// Explicit, rather than relying on the cache's size+mtime check to notice.
		// A filesystem that keeps mtime to a whole second could otherwise serve the
		// previous parse of a path a collision loop just reused.
		memoryIndex.invalidate(written.rel);

		const retired: string[] = [];
		for (const m of supers.matched) {
			if (markSuperseded(ctx.vaultRoot, m.rel, v.value.title).ok) {
				retired.push(m.title);
				// Rewritten in place, and the new frontmatter is what makes it sink.
				memoryIndex.invalidate(m.rel);
			}
		}

		const indexed = reindex();
		audit("remember", { rel: written.rel, scope: v.value.scope, projects: v.value.projects, indexed });

		return [
			`Recorded: ${written.rel}`,
			`Scope: ${v.value.scope}${v.value.projects.length ? ` → ${v.value.projects.join(", ")}` : ""}`,
			...(retired.length ? [`Superseded: ${retired.join("; ")} (kept and back-linked)`] : []),
			...(supers.unmatched.length ? [`Supersedes NOT matched: ${supers.unmatched.join(", ")}`] : []),
			...(dropped.length ? [`Links dropped as unresolvable: ${dropped.join(", ")}`] : []),
			...(unlinked.length ? [`Dangling wikilinks were unlinked: ${unlinked.join(", ")}`] : []),
			...(v.warnings.length ? ["", "Warnings:", ...v.warnings.map((w) => `- ${w}`)] : []),
			...(indexed ? [] : ["", "NOTE: the search index could not be refreshed, so this memory may not be findable by query yet."]),
		].join("\n");
	}

	function callRecordWork(args: Record<string, unknown>): string {
		// A field carrying tool-call framing means the call's serialization broke,
		// not that the author wrote something odd. Refuse: writing it produces a
		// corrupted note whose damage is invisible until a human reads the rendered
		// markup, which is exactly how one shipped unnoticed.
		const corrupted = findToolMarkup(args);
		if (corrupted) {
			return [
				`Refused: the "${corrupted}" field contains tool-call markup, so this call's arguments did not serialize correctly.`,
				"",
				"Nothing was written. Re-send with each field as plain prose, and check that",
				"a long list field was not folded into the preceding string.",
			].join("\n");
		}
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

	/**
	 * `reason` — seed from search, spawn, log, hand back the answer.
	 *
	 * A call with no question in it is the only one refused.
	 */
	async function callReason(args: Record<string, unknown>): Promise<string> {
		const question = String(args.question ?? "").trim();
		if (!question) return describeRefusal("no question given.", "Ask the judgement you need, in full.");

		// Nothing to reason over, and nothing coherent to say to a spawn about it:
		// with no exposed roots the seed is always empty, so the prompt would tell
		// it to go read the tree and not to read the tree at all, in the same
		// breath. Refuse where the configuration is, not in the prompt.
		if (policy.roots.length === 0) {
			return describeRefusal(
				"this vault exposes no folders, so there is nothing to reason over.",
				"Declare mcp_exposed_roots in vault-manifest.json, or leave it unset to serve the vault's own user_content_roots. `health` reports what is currently exposed.",
			);
		}

		const cfg = resolveReasonConfig(ctx.manifest);
		// The spawn reads the vault with its own tools, so it is told the same
		// boundary the seed was filtered through — all three of the policy's rules,
		// since never-expose files and `private:` notes live INSIDE exposed roots.
		// Without it the one tool that reads most is the one ignoring the config.
		const scope = { roots: policy.roots, memoryRoot: ctx.memoryRoot, neverExpose: [...policy.neverExpose] };

		// Seed with what the server already has, so the spawn does not spend turns
		// rediscovering it.
		const allowed = allowedSearchPaths(ctx.vaultRoot, policy);
		const seed = await qmdSearch(qmd(), allowed, question, REASON_SEED_HITS);

		// Written before the spawn, and a failure here is a refusal rather than a
		// raw protocol error: without this file the spawn has no recursion guard,
		// so it must not run. Its sibling `writeReasoningRecord` returns null on
		// failure because losing provenance is survivable; losing this is not.
		let mcpConfigPath: string;
		try {
			mcpConfigPath = writeIsolatedMcpConfig(ctx.vaultRoot);
		} catch (e) {
			return describeRefusal(
				"the spawn could not be isolated, so it was not started.",
				[
					"Writing the empty MCP config failed, and without it the reasoning session",
					"could call back into this server. Check that .claude/ is writable.",
					"",
					sanitize(e instanceof Error ? e.message : String(e)),
				].join("\n"),
			);
		}
		// The PERMITTED count, not `total` — a search whose every hit was withheld
		// has `total > 0` and nothing the spawn can see, and must take the
		// read-the-vault-yourself branch rather than be handed an empty block.
		const evidence = visibleHits(seed) > 0 ? seed.text : "";
		const r = await runReason(
			resolveClaudeCommand(),
			ctx.vaultRoot,
			cfg,
			reasoningPrompt(question, evidence, scope),
			mcpConfigPath,
		);

		audit(REASON_ACTION, reasonAuditDetail(question, cfg, r, scope));

		if (r.error) {
			// The evidence goes back here too. A spawn that never started is the case
			// where the caller most needs something to work with, and the search has
			// already been paid for either way.
			return describeRefusal(
				"the reasoning session could not start.",
				[sanitize(r.error), "", "Set OM_CLAUDE_BIN if your Claude CLI is not on this server's PATH.", "", seed.text].join("\n"),
			);
		}

		// A run can end without an answer — the timeout fires, the CLI errors, the
		// session stops early. Reporting that as an answer is the one outcome worse
		// than refusing, so it is named.
		if (!r.ok || !r.answer.trim()) {
			const why = `it ended early (${r.terminal}) after ${r.turns} turn(s).`;
			return describeRefusal(
				`no answer — ${why}`,
				[
					"Nothing partial is returned, because a truncated synthesis presented as a",
					"complete one is worse than no answer. The evidence search already found is",
					"below; a narrower question is usually the fix.",
					"",
					seed.text,
				].join("\n"),
			);
		}

		// The model that ACTUALLY ran is always named. An answer's worth depends on
		// which model produced it, and a pin can be silently ignored — that is the
		// surprise this layer already got caught by once, so the reported value is
		// the CLI's, never the one we asked for.
		// `"unknown"`, not `""` — `interpretRun` never returns an empty modelUsed on
		// a successful run, so testing for `""` never fired and every run whose JSON
		// lacked `modelUsage` was reported as contradicting the pin when nothing
		// was wrong.
		const mismatch = cfg.model !== null && r.modelUsed !== "unknown" && !r.modelUsed.includes(cfg.model);
		const record = writeReasoningRecord(ctx.vaultRoot, now(), question, r);

		return [
			// Returned as written. `sanitize` guards protocol ERRORS, where a raw
			// path is noise; an answer is the user's own vault read by the user's own
			// Claude, and redacting it would mangle legitimate content to defend
			// against nobody. Egress belongs to the injected contract, not here.
			r.answer.trim(),
			"",
			"---",
			`Reasoned over the vault in ${r.turns} turn(s), ${(r.wallMs / 1000).toFixed(1)}s. Reported cost $${r.costUsd.toFixed(4)}.`,
			mismatch
				? `⚠ Model: ${r.modelUsed} — NOT the pinned ${cfg.model}. Check reason.model in vault-manifest.json.`
				: cfg.model === null
					? `Model: ${r.modelUsed} (your CLI default — pin reason.model to change it).`
					: `Model: ${r.modelUsed} (pinned via reason.model).`,
			...(record ? [`Full record: ${record}`] : []),
		].join("\n");
	}

	function callHealth(): string {
		const who = caller();
		// Populate the cache before reporting on it. `recall` tells the user to run
		// health when a memory is missing, so this is routinely the FIRST call a
		// server serves — and "3 memories / 0 entries held" reads as a parse
		// failure when nothing is wrong.
		const entries = storeEntries();
		const parsed = entries.length;
		// Resolved HERE because this is the only surface a vault session reads.
		// `recall` has had the diagnostic since v8.3.0 and shows it to a foreign
		// repo, which cannot see `brain/` at all and so cannot fix a stale anchor
		// — the report was reaching the one party powerless to act on it. (#183)
		const promo = auditPromotions(
			ctx.vaultRoot,
			policy,
			entries.map((m) => ({ path: m.rel, facets: m.facets })),
		);
		const names = new Set(visibleFiles(ctx.vaultRoot, policy).map((f) => f.label));
		if (who.project) names.add(who.project);
		const h = health(ctx.vaultRoot, ctx.manifest, {
			knownNames: names,
			indexName: ctx.qmdIndex,
			home: process.env.HOME ?? process.env.USERPROFILE ?? null,
		});

		return [
			`Vault: ${ctx.vaultRoot}`,
			...(ctx.overriddenFrom
				? [
						`  ⚠ OM_VAULT_PATH points here instead of ${ctx.overriddenFrom}, where this server's launcher lives.`,
						"    If that is not deliberate, unset it — everything below describes the OTHER vault.",
					]
				: []),
			`Caller: ${who.project ?? "ANONYMOUS (no MCP roots — only general-scope memories are visible)"}${who.project ? ` (from the ${callerProjectSource(session.roots) === "declared" ? PROJECT_MARKER + " file" : "folder name"})` : ""}`,
			...(who.project && callerProjectSource(session.roots) === "folder"
				? [`  Another repo with this folder name would share this identity. Write a distinct name into ${PROJECT_MARKER} to separate them.`]
				: []),
			`Platforms: ${who.platforms.length ? who.platforms.join(", ") : "(none declared)"}`,
			`Memory root: ${h.memory.root}/ (${h.memory.memories} memor${h.memory.memories === 1 ? "y" : "ies"}, ${h.memory.source})`,
			// Reported because every failure in this layer otherwise presents as "no
			// results". `stale` is the one that matters: files that exist but this
			// server could not re-read, served from an older parse.
			`Parsed store: ${parsed} entr${parsed === 1 ? "y" : "ies"}${memoryIndex.stats.stale ? ` (${memoryIndex.stats.stale} served from an older parse — check permissions)` : ""}`,
			`Exposed roots: ${policy.roots.join(", ") || "(none)"} [${policy.source}]`,
			`Search index: ${ctx.qmdIndex ?? "(qmd default)"} · launcher ${ctx.qmdLauncher ? "found" : "NOT FOUND"}`,
			// `reason` is the one tool that spawns a session, and nothing bounds it.
			// Reporting the day's usage is what stands in for a limit: the answer to
			// "where did that go" has to exist somewhere, and this is where.
			`Reasoning today: ${reasonUsage(ctx.vaultRoot, ctx.manifest, now().toISOString().slice(0, 10), sumAuditField)}`,
			// Stated whenever anything is promoted, because "named only" is the
			// DEFAULT outcome of promoting by hand and is otherwise invisible: the
			// hygiene flag falls either way, so without this line a store where no
			// promotion serves anything looks identical to one where they all do.
			...(promo.served + promo.namedOnly > 0
				? [
						`Promotions: ${promo.served} servable, ${promo.namedOnly} named only${
							promo.namedOnly > 0 ? " (add an anchor — `promoted: \"brain/Note#^om-a1b2c3\"` — to serve the corrected text)" : ""
						}`,
					]
				: []),
			"",
			(() => {
				// A broken promotion is a warning; a bare marker never is. Serving is a
				// separate, deliberate act, and demanding an anchor would push one onto
				// captures whose promoted block is not fit to leave the vault.
				const mine = [
					...promo.broken.map(
						(b) =>
							`promotion in ${b.path} names ${b.note} but ${
								b.status === "stale-anchor"
									? "its anchor no longer resolves — the block was renamed, moved or removed"
									: b.status === "not-exposed"
										? "that note is outside the exposed roots"
										: "that note is missing or unreadable"
							}. recall falls back to the raw capture body.`,
					),
					...promo.unparsed.map(
						(p) => `promotion marker in ${p} could not be parsed — it is invisible to every consumer.`,
					),
				];
				const all = [...h.warnings, ...mine];
				return all.length ? `Warnings:\n${all.map((w) => `- ${w}`).join("\n")}` : "No warnings.";
			})(),
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
				case "reason":
					return session.ok(id, text(await callReason(args)));
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

			// The collection name is passed so a URI read straight out of a `search`
			// result resolves. See resolveResourceUri for what qmd does to paths.
			const full = resolveResourceUri(ctx.vaultRoot, policy, uri, ctx.qmdIndex);
			if (!full) {
				// Not-found rather than forbidden: to this server, a URI outside
				// the served set is simply not a resource it has.
				audit("resource_denied", { uri });
				return session.fail(id, `no such resource: ${uri}`, -32602);
			}

			// The canonical URI goes back, not the requested one, so a caller that
			// arrived via a prefixed or slugified path learns the form that works.
			// vaultRelKeyRaw, not vaultRelKey: the latter normalises case for
			// comparison, and a URI has to round-trip to a real file. Against
			// `vaultReal`, because `full` is a realpath.
			const rel = vaultRelKeyRaw(vaultReal, full);
			// `vaultRelKeyRaw` returns its input unchanged when the prefix does not
			// match, so anything still absolute means we have no clean relative path.
			// Echo the request rather than publish a filesystem path.
			const served =
				rel === full || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)
					? uri
					: `vault://note/${rel.split("/").map(encodeURIComponent).join("/")}`;
			audit("resource_read", served === uri ? { uri } : { uri: served, from: uri });
			session.ok(id, {
				contents: [{ uri: served, mimeType: "text/markdown", text: readFileSync(full, "utf8") }],
			});
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
