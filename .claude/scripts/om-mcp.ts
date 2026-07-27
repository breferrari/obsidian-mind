/**
 * The `om` MCP server — the vault, reachable from any repository.
 *
 * This file is deliberately thin. It owns exactly the things a test cannot
 * usefully drive: resolving the vault, opening stdio, and holding the lazy qmd
 * child. Every decision worth arguing about lives in `lib/mcp-*.ts`, where it
 * can be driven in-process — the prototype bound its handlers to module state
 * and stdio, and two bugs survived because checking anything needed a live
 * client.
 *
 * Registered in a consuming project's `.mcp.json` through the `om-mcp.mjs`
 * launcher, which adds the type-stripping flags this file needs.
 *
 * The server is only HALF the install. The other half is a short section in the
 * consuming repo's own CLAUDE.md, and that is not documentation garnish: a
 * prohibition in the MCP `instructions` field propagates into a calling session
 * reliably, while a positive instruction to go and consult the vault is
 * advisory and gets skipped whenever a nearer source exists. This server can
 * stop a session doing something; only the project's own law makes one look.
 */

import { createInterface } from "node:readline";

import { createContext, resolveVaultRoot, derivedVaultRoot } from "./lib/mcp-context.ts";
import { resolveExposure } from "./lib/mcp-exposure.ts";
import { McpSession, type Handlers } from "./lib/mcp-protocol.ts";
import { createQmdClient, type QmdClient } from "./lib/mcp-qmd-client.ts";
import { createAuditor, auditPath, callerProject } from "./lib/mcp-caller.ts";
import { createHandlers } from "./lib/mcp-server.ts";
import { killActiveReasoning } from "./lib/mcp-reason.ts";

const vaultRoot = resolveVaultRoot(import.meta.url);
const ctx = createContext(vaultRoot, derivedVaultRoot(import.meta.url));
const policy = resolveExposure(vaultRoot, ctx.manifest, ctx.memoryRoot);

/**
 * One long-lived qmd child, started on first use and REPLACED if it dies.
 *
 * Lazy because a vault with no qmd installed must still serve resources,
 * `expand`, `recall` and `health` — search is the only surface that degrades,
 * and it degrades to a message rather than to silence.
 *
 * Memoising it unconditionally was the bug: a single qmd crash left a dead
 * client in place, whose pending map rejects every later call, so search stayed
 * broken for the life of the server. The cooldown guards the opposite failure —
 * when qmd is missing or permanently broken, respawning per call would fork a
 * process for every search.
 */
let qmdClient: QmdClient | null = null;
let lastSpawn = 0;
const RESPAWN_COOLDOWN_MS = 5_000;

const qmd = (): QmdClient => {
	if (qmdClient?.alive) return qmdClient;
	const now = Date.now();
	if (qmdClient && now - lastSpawn < RESPAWN_COOLDOWN_MS) return qmdClient;
	lastSpawn = now;
	qmdClient = createQmdClient(vaultRoot, ctx.qmdLauncher);
	return qmdClient;
};

const send = (msg: unknown): void => {
	process.stdout.write(JSON.stringify(msg) + "\n");
};

// The session and its handlers are mutually referential: handlers reply through
// session.ok/fail, and the session dispatches into handlers. Sharing one object
// and filling it after construction keeps that honest without a proxy.
const handlers: Handlers = {};
const session = new McpSession({ send, handlers });
Object.assign(
	handlers,
	createHandlers({
		ctx,
		policy,
		session,
		qmd,
		audit: createAuditor(auditPath(vaultRoot), () => callerProject(session.roots)),
	}),
);

createInterface({ input: process.stdin }).on("line", (line) => {
	// Deliberately not awaited: MCP allows concurrent in-flight requests, and
	// serialising them here would make one slow search block every other call.
	void session.handleLine(line);
});

const shutdown = (): void => {
	qmdClient?.dispose();
	// A `reason` spawn is not detached and nothing else reaps it, while the only
	// bound on its lifetime is a timer in THIS process. Exiting without this
	// leaves a session running against the user's account that can never be
	// recorded, because the audit line follows an await that will never return.
	killActiveReasoning();
	process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
// stdin closing is how an MCP client says goodbye.
process.stdin.on("end", shutdown);
