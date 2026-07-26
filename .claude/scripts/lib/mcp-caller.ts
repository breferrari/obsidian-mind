/**
 * Who is calling, and what the answer is allowed to say.
 *
 * IDENTITY IS DERIVED, NEVER ASSERTED
 *
 * The caller's identity comes from the MCP `roots/list` handshake — the client
 * tells the server which directories the session is working in — and never from
 * a tool argument. That is the property the whole memory layer rests on: a
 * session cannot widen its own reach by claiming to be a different project,
 * because there is no argument through which to claim it.
 *
 * The cost of that choice is a real failure mode worth naming: a client that
 * does not complete the handshake is ANONYMOUS, and an anonymous caller sees
 * only `general`-scoped material. That is indistinguishable from an empty
 * vault, which is why `health` reports identity explicitly.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Root {
	readonly uri?: string;
	readonly name?: string;
}

/** Normalise a path for comparison: separators, trailing slash, case. */
export function normalizePath(x: unknown): string {
	return String(x ?? "")
		.split("\\")
		.join("/")
		.replace(/\/+$/, "")
		.toLowerCase();
}

/**
 * Turn a `file://` root URI into a plain path.
 *
 * Handles the two- and three-slash forms and percent-encoding, both of which
 * appear in the wild depending on the client and the platform.
 */
export function rootToPath(uri: unknown): string {
	// Strip only the scheme and authority. An earlier version also ate the third
	// slash, which is correct for `file:///C:/x` and WRONG for `file:///home/x`:
	// on POSIX that slash is the filesystem root, not a URI artifact. Losing it
	// made every root a relative path, so isVaultItself() could never match a
	// real vault and the "vault does not write to its own memory" guard FAILED
	// OPEN on Linux and macOS.
	const raw = String(uri ?? "").replace(/^file:\/\//, "");
	// `/C:/Dev/x` → `C:/Dev/x`. Only a drive-letter path sheds its leading slash.
	const path = /^\/[A-Za-z]:/.test(raw) ? raw.slice(1) : raw;
	try {
		return decodeURIComponent(path);
	} catch {
		return path;
	}
}

/**
 * The calling repo's name, used as its project identity.
 *
 * The last path segment of the first root. This is a CONVENTION, not a
 * guarantee — two repos sharing a folder name collide, and that limitation is
 * documented rather than papered over, because the alternative (asking the
 * caller who it is) reintroduces exactly the assertion this design removes.
 */
export function callerProject(roots: readonly Root[]): string | null {
	const first = roots[0];
	if (!first) return null;
	const seg = rootToPath(first.uri)
		.replace(/\/+$/, "")
		.split(/[\\/]/)
		.filter(Boolean)
		.pop();
	return seg ? seg.toLowerCase() : null;
}

/**
 * Is the caller the vault itself?
 *
 * Registering this server in the vault's own `.mcp.json` is a natural thing to
 * try, and it must not silently produce nonsense. A session inside the vault
 * already reads every note directly; a memory written from there would be
 * scoped to the vault-as-a-project and reach only the sessions that never
 * needed it. So writes are refused with an explanation rather than accepted
 * into a dead end.
 *
 * Compared across ALL roots, not just the first: a session can legitimately
 * open the vault as a secondary directory.
 */
export function isVaultItself(vaultRoot: string, roots: readonly Root[]): boolean {
	if (!roots.length) return false;
	const vault = normalizePath(vaultRoot);
	return roots.some((r) => normalizePath(rootToPath(r.uri)) === vault);
}

/**
 * Strip local absolute paths out of anything crossing back to the caller.
 *
 * Error text lands in the CALLING session, which may paste it into a commit
 * message, a PR body or an issue. Local absolute paths are precisely the
 * artifact class this project's leak guard exists to keep out of repositories,
 * and raw filesystem errors are full of them:
 *
 *   ENOENT: no such file or directory, lstat 'C:\Users\someone\vault\CLAUDE.md'
 *
 * Stripped at the boundary rather than at each throw site, because the one
 * that gets forgotten is the one that leaks.
 */
export function sanitize(message: unknown): string {
	return String(message)
		// A drive letter is ONE letter, so it must not be preceded by another —
		// without the lookbehind, "vault://note/x" matches from its "t://note/x"
		// and every URI in an error message is destroyed. Found by a wire probe,
		// not by any of the unit tests, which only ever fed it real fs errors.
		.replace(/(?<![A-Za-z])[A-Za-z]:[\\/][^\s'"`)]+/g, "<path>")
		.replace(/\/(?:home|Users|users|root)\/[^\s'"`)]+/g, "<path>")
		.replace(/\\\\[^\s'"`)]+/g, "<path>");
}

export interface AuditEntry {
	readonly action: string;
	readonly caller: string;
	readonly at: string;
	readonly [key: string]: unknown;
}

/**
 * Append-only audit log.
 *
 * Every read is recorded with the calling repo, because "a coding session in
 * repo X can read the vault" is only a defensible position if you can
 * afterwards say exactly what it read. Failure here is swallowed on purpose:
 * an audit log that can break the server is a liability, not a control.
 */
export function createAuditor(
	logPath: string,
	getCaller: () => string | null,
	now: () => string = () => new Date().toISOString(),
): (action: string, detail?: Record<string, unknown>) => void {
	let ensured = false;
	return (action, detail = {}) => {
		try {
			if (!ensured) {
				mkdirSync(dirname(logPath), { recursive: true });
				ensured = true;
			}
			// Detail spreads FIRST so the authoritative fields overwrite it, never
			// the other way round. A tool argument happening to be named `caller`
			// must not be able to forge the identity recorded against its own call
			// — an audit log a caller can write its own name into is worthless.
			const entry: AuditEntry = {
				...detail,
				action,
				caller: getCaller() ?? "unknown",
				at: now(),
			};
			appendFileSync(logPath, JSON.stringify(entry) + "\n");
		} catch {
			/* auditing must never break the server */
		}
	};
}

/** Where the audit log lives for a given vault. */
export function auditPath(vaultRoot: string): string {
	return join(vaultRoot, ".claude", "om-mcp-audit.jsonl");
}
