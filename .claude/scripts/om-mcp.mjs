#!/usr/bin/env node
/**
 * om-mcp.mjs — launcher for the `om` MCP server.
 *
 * Exists so a consuming project's `.mcp.json` can be one plain line:
 *
 *   { "command": "node", "args": ["<vault>/.claude/scripts/om-mcp.mjs"] }
 *
 * The server itself is TypeScript, which needs `--experimental-strip-types`.
 * Putting that flag in every consuming repo's config would mean every one of
 * them has to be edited when the flag stops being needed — and a stale flag in
 * someone else's repo is exactly the kind of breakage nobody attributes back
 * here. Same reasoning as `qmd-mcp.mjs`, which this deliberately mirrors.
 *
 * Re-exec rather than dynamic import: the flags must be set at process start.
 * stdio is inherited, so the child speaks MCP directly to the client and this
 * process is a transparent shim on the wire.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "om-mcp.ts");

const child = spawn(
	process.execPath,
	["--disable-warning=ExperimentalWarning", "--experimental-strip-types", server, ...process.argv.slice(2)],
	{ stdio: "inherit", env: process.env },
);

// Forward termination so the client's shutdown reaches the real server rather
// than orphaning it.
for (const sig of ["SIGTERM", "SIGINT"]) {
	process.on(sig, () => child.kill(sig));
}

child.on("exit", (code, signal) => {
	process.exit(signal ? 1 : (code ?? 0));
});

child.on("error", (err) => {
	// stderr, never stdout: stdout is the MCP channel and any non-JSON byte on
	// it corrupts the stream for the client.
	process.stderr.write(`om-mcp: failed to start server: ${err.message}\n`);
	process.exit(1);
});
