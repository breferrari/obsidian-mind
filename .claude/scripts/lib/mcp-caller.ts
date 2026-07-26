/**
 * Caller identity, and sanitising what crosses back to it.
 *
 * Identity comes from the MCP `roots/list` handshake — never from a tool
 * argument, so a session cannot claim to be a project it is not. A client that
 * does not complete the handshake is anonymous and sees only `general`-scoped
 * memories; `health` reports that explicitly, since it otherwise looks like an
 * empty vault.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Root {
	readonly uri?: string;
	readonly name?: string;
}

/**
 * Normalise a path for comparison: separators, trailing slash, case, and the
 * leading slash a drive-letter path carries on platforms without drives
 * (`fileURLToPath("file:///C:/x")` is `C:\x` on Windows, `/C:/x` elsewhere).
 */
export function normalizePath(x: unknown): string {
	return String(x ?? "")
		.split("\\")
		.join("/")
		.replace(/^\/(?=[A-Za-z]:)/, "")
		.replace(/\/+$/, "")
		.toLowerCase();
}

/** Turn a `file://` root URI into a plain path. */
export function rootToPath(uri: unknown): string {
	const raw = String(uri ?? "");

	if (/^file:\/\//i.test(raw)) {
		try {
			return fileURLToPath(raw);
		} catch {
			// Fall through: clients also send the two-slash `file://C:/x` form,
			// which is not a legal file URL. Parsing it tolerantly beats treating
			// the caller as anonymous.
		}
	}

	const stripped = raw.replace(/^file:\/\//i, "");
	const path = /^\/[A-Za-z]:/.test(stripped) ? stripped.slice(1) : stripped;
	try {
		return decodeURIComponent(path);
	} catch {
		return path;
	}
}

/**
 * The calling repo's name, used as its project identity: the last segment of
 * the first root. A convention rather than a guarantee — two repos sharing a
 * folder name collide.
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
 * Is the caller the vault itself? Checked across all roots, since a session can
 * open the vault as a secondary directory. Used to refuse memory writes from
 * inside the vault, which would reach only sessions that already read it.
 */
export function isVaultItself(vaultRoot: string, roots: readonly Root[]): boolean {
	if (!roots.length) return false;
	const vault = normalizePath(vaultRoot);
	return roots.some((r) => normalizePath(rootToPath(r.uri)) === vault);
}

/**
 * Replace local absolute paths with `<path>`.
 *
 * Error text reaches the calling session and may be pasted into a commit or an
 * issue; raw filesystem errors carry full local paths. Applied at this single
 * boundary rather than per throw site. Vault-relative paths are left alone —
 * those are citations.
 */
export function sanitize(message: unknown): string {
	return String(message)
		// The lookbehind keeps a drive letter to ONE letter, so `vault://note/x`
		// is not read as a `t:` drive path.
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
 * Append-only log of what each caller read. Write failures are swallowed: the
 * log must never be able to break the server.
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
			// Detail spreads first so the authoritative fields win: a tool argument
			// named `caller` must not be able to forge the recorded identity.
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
