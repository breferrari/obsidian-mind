/**
 * Caller identity, and sanitising what crosses back to it.
 *
 * Identity comes from the MCP `roots/list` handshake — never from a tool
 * argument, so a session cannot claim to be a project it is not. A client that
 * completes no handshake may declare one in {@link CALLER_VAR} instead, which
 * is set where the server is registered rather than chosen by the session and
 * so sits on the same trust boundary as `roots`; that constant carries the
 * whole argument. A client that does neither is anonymous and sees only
 * `general`-scoped memories; `health` reports that explicitly, since it
 * otherwise looks like an empty vault.
 */

import {
	appendFileSync,
	closeSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
} from "node:fs";
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

/** Where a repo may declare its own project name, overriding the folder name. */
export const PROJECT_MARKER = ".om-project";

/**
 * Where a client with no roots may declare an identity instead.
 *
 * **A real consumer arrived that cannot send roots.** Not every shipping MCP
 * client implements the handshake: one answers `initialize` and leaves the
 * server's `roots/list` request unanswered. It was not rootless for want of a
 * directory, so {@link PROJECT_MARKER} cannot help it either, since nothing
 * reads that file without a root to read it under. The consequence is not
 * cosmetic: an identity-less caller is served **only** `general`-scoped
 * memories, which is the narrowest slice of the vault there is.
 *
 * **Why this does not reopen the forgery hole the header refuses.** That rule
 * is about a *tool argument*, which the model chooses mid-session and could
 * therefore point at any project it liked. An environment variable is set by
 * whoever registers and spawns this server, which is the same party that
 * controls `roots` and could already declare any identity that way. Same trust
 * boundary, no new surface. What stays refused is the session naming itself.
 *
 * **A fallback and never an override.** A client that sends roots is
 * identifying itself, and second-guessing that with an environment left over
 * from another context is how one repo starts answering as another.
 */
export const CALLER_VAR = "OM_CALLER";

/** Reads one environment variable. Injected so the identity rules stay pure. */
export type EnvLookup = (key: string) => string | undefined;

const fromProcess: EnvLookup = (key) => process.env[key];

/**
 * The one shape an identity may take, wherever it was declared.
 *
 * Shared by the marker file and {@link CALLER_VAR} rather than spelled at each,
 * because two copies of a validation rule are two chances for one of them to
 * accept a path segment the scope comparison would then read oddly.
 */
function identityShape(raw: unknown): string | null {
	const name = String(raw ?? "").trim().toLowerCase();
	return name && /^[\w.-]+$/.test(name) ? name : null;
}

/** The identity declared in the environment, if it is one this may accept. */
function declaredByEnv(env: EnvLookup): string | null {
	return identityShape(env(CALLER_VAR));
}

/**
 * The calling repo's project identity.
 *
 * The folder name by default. A repo can override that by writing a single
 * line into `.om-project`, which is what resolves the one real failure here:
 * two repos both called `api` otherwise share an identity, so each receives
 * the other's memories. Declaring a distinct name in either repo separates
 * them, and nothing changes for anyone who does not hit the collision.
 */
export function callerProject(roots: readonly Root[], env: EnvLookup = fromProcess): string | null {
	const first = roots[0];
	if (!first) return declaredByEnv(env);
	const root = rootToPath(first.uri).replace(/\/+$/, "");

	const declared = readProjectMarker(root);
	if (declared) return declared;

	// A root carrying no usable path is the rootless case wearing a handshake, so
	// it falls through to the environment rather than straight to anonymity.
	const seg = root.split(/[\\/]/).filter(Boolean).pop();
	return seg ? seg.toLowerCase() : declaredByEnv(env);
}

/** How the identity was decided, so `health` can explain itself. */
export function callerProjectSource(
	roots: readonly Root[],
	env: EnvLookup = fromProcess,
): "declared" | "folder" | "env" | "none" {
	const first = roots[0];
	if (first) {
		const root = rootToPath(first.uri).replace(/\/+$/, "");
		if (readProjectMarker(root)) return "declared";
		if (root.split(/[\\/]/).filter(Boolean).length) return "folder";
	}
	return declaredByEnv(env) ? "env" : "none";
}

function readProjectMarker(root: string): string | null {
	try {
		const raw = readFileSync(join(root, PROJECT_MARKER), "utf8")
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l && !l.startsWith("#"));
		// Same shape as a folder name, so a declared identity cannot smuggle in a
		// path segment or anything the scope rule would compare oddly.
		return identityShape(raw);
	} catch {
		return null;
	}
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
 * Append-only log of what each caller did, including what it was REFUSED.
 * Successes alone answer "what did this repo read and write" and cannot answer
 * "what did it try and fail to do", which is the question a refusal loop needs.
 * Write failures are swallowed: the log must never be able to break the server.
 */
/** Rotate at 5MB — roughly a year of ordinary use, kept for one generation. */
export const AUDIT_MAX_BYTES = 5 * 1024 * 1024;

export function createAuditor(
	logPath: string,
	getCaller: () => string | null,
	now: () => string = () => new Date().toISOString(),
	maxBytes: number = AUDIT_MAX_BYTES,
): (action: string, detail?: Record<string, unknown>) => void {
	let ensured = false;
	return (action, detail = {}) => {
		try {
			if (!ensured) {
				mkdirSync(dirname(logPath), { recursive: true });
				ensured = true;
			}
			// One generation kept, then dropped. An append-only log with no bound
			// grows for the life of the vault, and this one records a line per read.
			try {
				if (statSync(logPath).size >= maxBytes) renameSync(logPath, `${logPath}.1`);
			} catch {
				/* absent, or a rotation that lost a race — either way, keep writing */
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

/**
 * How much of the tail to read back. The log is append-only and time-ordered, so
 * one day's entries are contiguous at the end; a fixed window keeps a read
 * bounded no matter how large the log has grown.
 */
const AUDIT_TAIL_BYTES = 512 * 1024;

/**
 * Read the last `AUDIT_TAIL_BYTES` of a file, dropping a torn leading line.
 *
 * `whole` says whether the window reached the start of the file. A caller
 * summing a day cannot know from the numbers alone whether it saw all of them,
 * and a silently-low figure is worse than an explicitly partial one.
 */
function tail(path: string): { text: string; whole: boolean } {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		// Absent is "nothing to add", not "truncated" — a vault with no log yet
		// must not report its zero as partial.
		return { text: "", whole: true };
	}
	try {
		// The OPEN FILE, not the path — that is the whole reason the fd is held.
		// `createAuditor` can rotate between the open and the stat, and then
		// `statSync(path)` describes the fresh live file while the fd still points
		// at the renamed inode. Measured: a 61-byte stat against a 680KB fd made
		// `from` compute to 0, which skipped the torn-line drop AND re-read the
		// head of a generation the caller had already summed — double-counting it.
		const size = fstatSync(fd).size;
		// One byte BEFORE the window when there is one, so an aligned boundary can
		// be told from a torn one. Without it, a window that happens to start
		// exactly at a line start discards a whole valid entry — proven with
		// fixed-width entries: 4,096 inside the window, 4,095 summed.
		const from = size > AUDIT_TAIL_BYTES ? size - AUDIT_TAIL_BYTES - 1 : 0;
		const buf = Buffer.allocUnsafe(size - from);
		let read = 0;
		while (read < buf.length) {
			const n = readSync(fd, buf, read, buf.length - read, from + read);
			if (n <= 0) break;
			read += n;
		}
		// Decoding from an arbitrary byte offset can split a multi-byte character,
		// but only at the START — the window always ends at EOF — and any partial
		// leading line is dropped below.
		const text = buf.subarray(0, read).toString("utf8");
		if (from === 0) return { text, whole: true };
		// The probe byte was a newline, so the window began on a line boundary and
		// every line after it is complete. Otherwise the first line is torn.
		return text.startsWith("\n")
			? { text: text.slice(1), whole: false }
			: { text: text.slice(text.indexOf("\n") + 1), whole: false };
	} catch {
		return { text: "", whole: true };
	} finally {
		closeSync(fd);
	}
}

/**
 * Can we prove the oldest surviving entry predates the day?
 *
 * Only then is a partial read still a complete answer for that day. An
 * unreadable or absent first entry proves nothing, so it counts as partial.
 */
function predatesDay(text: string, dayPrefix: string): boolean {
	const first = text.split("\n", 1)[0];
	if (!first?.trim()) return false;
	try {
		const at = (JSON.parse(first) as AuditEntry).at;
		return typeof at === "string" && at < dayPrefix;
	} catch {
		return false;
	}
}

/**
 * Sum a numeric field across today's entries for one action.
 *
 * Lives here, beside the writer, because everything it depends on is this
 * module's business: the entry shape, the `at` format, the log's path, and the
 * ROTATION. `createAuditor` renames the log to `.jsonl.1` once it crosses
 * `AUDIT_MAX_BYTES`, so a reader that knows only the live path reports zero for
 * a day that did spend — the rotated generation is read too, for exactly that
 * reason. Kept away from its writer, this drifts the moment either side changes.
 *
 * Reads a bounded tail rather than the whole file: the caller is `health`, which
 * is routinely the FIRST call a server serves, and the log records a line per
 * read across every consuming repo sharing this vault.
 *
 * Unparseable lines are skipped rather than throwing — a torn write may
 * under-report, but it must never take `health` down with it.
 */
export function sumAuditField(
	vaultRoot: string,
	action: string,
	dayPrefix: string,
	field: string,
): { total: number; complete: boolean } {
	const live = auditPath(vaultRoot);
	const generations = [tail(`${live}.1`), tail(live)];
	let complete = true;
	let total = 0;
	for (const { text, whole } of generations) {
		// A partial read is only provably complete for the DAY if its oldest
		// surviving entry already predates the day — then nothing of today can be
		// hiding behind it. Anything else counts as partial, INCLUDING a window
		// that yielded no readable entry at all: one audit line larger than the
		// window leaves exactly that, and an earlier version read the resulting
		// empty text as "no entries today" and reported a confident zero.
		if (!whole) complete &&= predatesDay(text, dayPrefix);
		for (const line of text.split("\n")) {
			// Cheap reject before the parse: any encoding of an entry with this
			// action contains the action's name somewhere in the line.
			if (!line.includes(action)) continue;
			try {
				const e = JSON.parse(line) as AuditEntry;
				if (e.action !== action) continue;
				if (typeof e.at !== "string" || !e.at.startsWith(dayPrefix)) continue;
				const v = e[field];
				if (typeof v === "number" && Number.isFinite(v)) total += v;
			} catch {
				/* a torn or hand-edited line is skipped, never fatal */
			}
		}
	}
	return { total, complete };
}
