/**
 * Caller identity and the outbound boundary.
 *
 * Two independent properties.
 *
 * Identity is DERIVED from the roots handshake, so a session cannot claim to be
 * a project it is not — which is what makes every scoping rule downstream mean
 * anything. And the sanitiser replaces local absolute paths in anything crossing
 * back, because error text lands in the calling session and may be pasted into a
 * commit or an issue.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	normalizePath,
	rootToPath,
	callerProject,
	callerProjectSource,
	PROJECT_MARKER,
	isVaultItself,
	sanitize,
	createAuditor,
	auditPath,
	sumAuditField,
	type Root,
} from "../lib/mcp-caller.ts";

const root = (uri: string): Root => ({ uri });

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe("reading the caller's identity from roots", () => {
	test("handles the two- and three-slash file URI forms", () => {
		// Asserted through normalizePath rather than as an exact string, because a
		// drive-letter URI resolves to the NATIVE form: `C:\Dev\atlas` on Windows
		// but `/C:/Dev/atlas` on POSIX, which has no drive concept. Pinning either
		// passes on the machine it was written on and fails on the CI matrix — as
		// this test did. normalizePath absorbs the difference, and comparison is
		// what every caller actually does with the value.
		assert.equal(normalizePath(rootToPath("file:///C:/Dev/atlas")), normalizePath("C:/Dev/atlas"));
		assert.equal(normalizePath(rootToPath("file://C:/Dev/atlas")), normalizePath("C:/Dev/atlas"));
	});

	test("a drive path compares equal however the platform rendered it", () => {
		// The regression itself: identical roots must not compare unequal because
		// of which platform parsed the URI.
		assert.equal(normalizePath("/C:/Dev/atlas"), normalizePath("C:\\Dev\\atlas"));
		assert.equal(normalizePath("/c:/dev/atlas"), "c:/dev/atlas");
		// A POSIX root must NOT have its leading slash stripped — that slash is
		// the filesystem root, not a URI artifact.
		assert.equal(normalizePath("/home/x/atlas"), "/home/x/atlas");
	});

	test("a POSIX root KEEPS its leading slash — that slash is the filesystem root", () => {
		// Regression, and the test that previously encoded the bug as expected.
		// The old pattern ate the third slash unconditionally, which is right for
		// `file:///C:/x` and wrong for `file:///home/x`. Every POSIX root became a
		// relative path, so isVaultItself() could never match and the guard against
		// the vault writing to its own memory layer failed OPEN on Linux and macOS.
		assert.equal(rootToPath("file:///home/x/atlas"), "/home/x/atlas");
		assert.equal(rootToPath("file:///Users/x/vault"), "/Users/x/vault");
	});

	test("percent-encoding is decoded, and a malformed escape does not throw", () => {
		assert.equal(normalizePath(rootToPath("file:///C:/Dev/my%20app")), normalizePath("C:/Dev/my app"));
		assert.equal(normalizePath(rootToPath("file:///home/x/my%20app")), "/home/x/my app");
		// A stray `%` is not a legal escape. It must degrade, not throw the
		// caller's identity away — an exception here would make the session
		// anonymous, which silently narrows its scope to `general`.
		assert.equal(normalizePath(rootToPath("file:///C:/Dev/100%")), normalizePath("C:/Dev/100%"));
	});

	test("the project is the last segment, lowercased", () => {
		assert.equal(callerProject([root("file:///C:/Dev/Atlas")]), "atlas");
		assert.equal(callerProject([root("file:///C:/Dev/atlas/")]), "atlas");
		assert.equal(callerProject([root("file:///home/x/pocket")]), "pocket");
	});

	test("no roots means NO identity — never a guess and never a default", () => {
		// An anonymous caller must fall through to general-scoped material only.
		// Inventing an identity here would hand it another project's memories.
		assert.equal(callerProject([]), null);
		assert.equal(callerProject([{}]), null);
		assert.equal(callerProject([root("")]), null);
	});

	test("the first root wins when a session has several", () => {
		assert.equal(callerProject([root("file:///C:/Dev/atlas"), root("file:///C:/Dev/other")]), "atlas");
	});

	test("a repo can declare its own identity, which separates same-named repos", () => {
		// Two repos both called `api` otherwise share an identity, so each
		// receives the other's memories — a relevance failure, not a security one.
		const dir = mkdtempSync(join(tmpdir(), "marker-"));
		try {
			const uri = pathToFileURL(dir).href;
			assert.equal(callerProject([root(uri)]), basename(dir).toLowerCase(), "folder name by default");
			assert.equal(callerProjectSource([root(uri)]), "folder");

			writeFileSync(join(dir, PROJECT_MARKER), "# which api is this\nbilling-api\n", "utf8");
			assert.equal(callerProject([root(uri)]), "billing-api");
			assert.equal(callerProjectSource([root(uri)]), "declared");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a declared identity cannot smuggle in a path or junk", () => {
		const dir = mkdtempSync(join(tmpdir(), "marker2-"));
		try {
			const uri = pathToFileURL(dir).href;
			for (const bad of ["../escape", "a/b", "with spaces", "", "   "]) {
				writeFileSync(join(dir, PROJECT_MARKER), bad, "utf8");
				assert.equal(callerProject([root(uri)]), basename(dir).toLowerCase(), `refused: ${JSON.stringify(bad)}`);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("recognising the vault itself", () => {
	test("a session whose root IS the vault is recognised", () => {
		assert.equal(isVaultItself("C:/Dev/myvault", [root("file:///C:/Dev/myvault")]), true);
	});

	test("recognised on POSIX too — the guard must not fail open off Windows", () => {
		// This is the whole point of the guard: a memory recorded from inside the
		// vault is scoped to the vault-as-a-project and reaches only sessions that
		// already read every note directly. It was returning false on Linux and
		// macOS, so the refusal never fired there.
		assert.equal(isVaultItself("/home/x/myvault", [root("file:///home/x/myvault")]), true);
		assert.equal(isVaultItself("/Users/x/myvault", [root("file:///Users/x/myvault/")]), true);
		assert.equal(isVaultItself("/home/x/myvault", [root("file:///home/x/other")]), false);
	});

	test("separator style, trailing slash and case do not matter", () => {
		for (const uri of [
			"file:///C:/Dev/MyVault",
			"file:///C:/Dev/myvault/",
			"file:///C:\\Dev\\myvault",
		]) {
			assert.equal(isVaultItself("C:\\Dev\\myvault", [root(uri)]), true, uri);
		}
	});

	test("the vault as a SECONDARY root still counts", () => {
		// A session can legitimately open the vault as an extra directory, and it
		// is still the vault writing to itself.
		assert.equal(
			isVaultItself("C:/Dev/myvault", [root("file:///C:/Dev/atlas"), root("file:///C:/Dev/myvault")]),
			true,
		);
	});

	test("an ordinary repo is not the vault", () => {
		assert.equal(isVaultItself("C:/Dev/myvault", [root("file:///C:/Dev/atlas")]), false);
	});

	test("a repo NESTED inside the vault is not the vault", () => {
		// It is a different project that happens to live there, and its memories
		// are legitimately its own.
		assert.equal(isVaultItself("C:/Dev/myvault", [root("file:///C:/Dev/myvault/sub")]), false);
	});

	test("an anonymous caller is not the vault", () => {
		assert.equal(isVaultItself("C:/Dev/myvault", []), false);
	});
});

// ---------------------------------------------------------------------------
// The outbound boundary
// ---------------------------------------------------------------------------

describe("sanitising text that crosses back to the caller", () => {
	test("a Windows path in a real fs error is stripped", () => {
		const msg = "ENOENT: no such file or directory, lstat 'C:\\Users\\someone\\vault\\CLAUDE.md'";
		const out = sanitize(msg);
		assert.ok(!out.includes("Users"), out);
		assert.ok(!out.includes("someone"), out);
		assert.match(out, /<path>/);
	});

	test("a POSIX home path is stripped", () => {
		for (const p of ["/home/someone/vault/note.md", "/Users/someone/vault/note.md", "/root/secret"]) {
			const out = sanitize(`failed reading ${p}`);
			assert.ok(!out.includes("someone") && !out.includes("secret"), out);
			assert.match(out, /<path>/);
		}
	});

	test("a UNC path is stripped", () => {
		assert.match(sanitize("cannot open \\\\server\\share\\vault\\a.md"), /<path>/);
		assert.ok(!sanitize("cannot open \\\\server\\share\\vault\\a.md").includes("server"));
	});

	test("the message around the path survives — this is not redaction of everything", () => {
		const out = sanitize("ENOENT: no such file or directory, lstat 'C:\\v\\a.md'");
		assert.match(out, /ENOENT/);
		assert.match(out, /no such file/);
	});

	test("a vault-relative path is NOT stripped, because that is what a citation is", () => {
		const out = sanitize("see brain/Gotchas.md for the reasoning");
		assert.equal(out, "see brain/Gotchas.md for the reasoning");
	});

	test("multiple paths in one message are all stripped", () => {
		const out = sanitize("copy 'C:\\a\\b.md' to '/home/x/c.md'");
		assert.equal((out.match(/<path>/g) ?? []).length, 2);
	});

	test("a URI survives — a drive letter is ONE letter, not any letter", () => {
		// Regression: "vault://note/work/Secret.md" matched from its "t://note/..."
		// and came back as "vaul<path>", destroying every URI in every error
		// message. A wire probe caught it; none of the fs-error cases above could.
		for (const uri of [
			"vault://note/brain/Gotchas.md",
			"file:///c/x",
			"https://example.com/a/b",
			"qmd://index/thing",
		]) {
			assert.equal(sanitize(`no such resource: ${uri}`), `no such resource: ${uri}`, uri);
		}
	});

	test("a real drive path at a word boundary is still stripped", () => {
		assert.match(sanitize("open C:\\vault\\a.md"), /<path>/);
		assert.match(sanitize("(C:/vault/a.md)"), /<path>/);
		assert.match(sanitize("'D:\\other\\b.md'"), /<path>/);
	});

	test("a non-string is coerced rather than throwing", () => {
		assert.equal(sanitize(undefined), "undefined");
		assert.equal(sanitize(new Error("boom").message), "boom");
	});
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

describe("the audit log", () => {
	function withDir(fn: (dir: string) => void): void {
		const dir = mkdtempSync(join(tmpdir(), "audit-"));
		try {
			fn(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	test("records the action, the caller and a timestamp as one JSON line each", () => {
		withDir((dir) => {
			const log = join(dir, "nested", "audit.jsonl");
			const audit = createAuditor(log, () => "atlas", () => "2026-07-26T00:00:00Z");
			audit("search", { query: "tokens", bytes: 42 });
			audit("recall");
			const lines = readFileSync(log, "utf8").trim().split("\n");
			assert.equal(lines.length, 2);
			const first = JSON.parse(lines[0]!);
			assert.equal(first.action, "search");
			assert.equal(first.caller, "atlas");
			assert.equal(first.at, "2026-07-26T00:00:00Z");
			assert.equal(first.query, "tokens");
		});
	});

	test("an anonymous caller is logged as unknown, not omitted", () => {
		withDir((dir) => {
			const log = join(dir, "audit.jsonl");
			createAuditor(log, () => null)("search");
			assert.equal(JSON.parse(readFileSync(log, "utf8").trim()).caller, "unknown");
		});
	});

	test("an unwritable log NEVER breaks the caller", () => {
		// A control that can take the server down is a liability, not a control.
		withDir((dir) => {
			// The unwritable path is one whose PARENT is a regular file. The auditor
			// mkdir -p's that parent, and a file cannot become a directory on any
			// platform, so the failure path is the one taken EVERYWHERE.
			//
			// Why not a drive letter: this asserted against `Z:/definitely/not/` for
			// four releases. `join` builds that from a drive letter only on Windows;
			// on POSIX it is an ordinary RELATIVE directory, so the Linux runner
			// created it, wrote the log, and passed by exercising the SUCCESS path.
			// It also shipped — `zip -r .` packaged the residue into the v8.1.1 and
			// v8.3.0 vault zips. A fixture that means different things on different
			// platforms tests the property it names on neither.
			const occupied = join(dir, "occupied");
			writeFileSync(occupied, "");
			const logPath = join(occupied, "here.jsonl");

			const audit = createAuditor(logPath, () => "x");
			assert.doesNotThrow(() => audit("search", { query: "q" }));

			// The teeth. Without this the test also passes when the write SUCCEEDS,
			// which is exactly how the drive-letter version passed on Linux.
			assert.equal(existsSync(logPath), false, "the log must not have been written");
		});
	});

	test("the log rotates instead of growing without bound", () => {
		withDir((dir) => {
			const log = join(dir, "audit.jsonl");
			const audit = createAuditor(log, () => "atlas", () => "2026-07-26T00:00:00Z", 400);
			for (let i = 0; i < 40; i++) audit("search", { query: `query number ${i} with some padding` });
			assert.ok(existsSync(`${log}.1`), "a rotated generation must exist");
			assert.ok(readFileSync(log, "utf8").length < 400 * 3, "the live log stays bounded");
			// The most recent entry is still in the live file, not lost to rotation.
			assert.match(readFileSync(log, "utf8"), /query number 39/);
		});
	});

	test("rotation never breaks the write", () => {
		withDir((dir) => {
			const log = join(dir, "audit.jsonl");
			const audit = createAuditor(log, () => "atlas", () => "t", 1);
			assert.doesNotThrow(() => {
				audit("a");
				audit("b");
				audit("c");
			});
		});
	});

	test("the log lands inside the vault, where the repo can ignore it", () => {
		assert.equal(auditPath("C:/v"), join("C:/v", ".claude", "om-mcp-audit.jsonl"));
	});

	test("the log is actually gitignored, and the two places agree", () => {
		// Two sources of truth for one path: auditPath() decides where the file
		// goes, .gitignore decides whether it is tracked. Changing one silently
		// stops the other from matching, and the symptom is a churning log file —
		// full of the user's own query strings — appearing in every commit.
		const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
		const rel = auditPath("").replace(/^[\\/]+/, "").split(/[\\/]/).join("/");
		const gitignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");
		assert.ok(
			gitignore.split(/\r?\n/).some((line) => line.trim() === rel),
			`.gitignore must contain "${rel}" — auditPath() and .gitignore have drifted`,
		);
	});

	test("detail keys cannot overwrite the action or the caller", () => {
		withDir((dir) => {
			const log = join(dir, "audit.jsonl");
			// Spread order matters: a tool argument named `caller` must not be able
			// to forge the identity recorded against its own call.
			createAuditor(log, () => "atlas")("search", { caller: "someone-else", action: "innocent" });
			const entry = JSON.parse(readFileSync(log, "utf8").trim());
			assert.equal(entry.caller, "atlas");
			assert.equal(entry.action, "search");
		});
	});

	test("nothing is created until something is logged", () => {
		withDir((dir) => {
			const log = join(dir, "sub", "audit.jsonl");
			createAuditor(log, () => "x");
			assert.equal(existsSync(log), false);
		});
	});
});

// ---------------------------------------------------------------------------
// Reading the log back — lives here so it cannot drift from the writer
// ---------------------------------------------------------------------------

describe("summing a field across one day's entries", () => {
	function withVault(fn: (root: string) => void): void {
		const dir = mkdtempSync(join(tmpdir(), "auditsum-"));
		try {
			fn(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	const entry = (o: Record<string, unknown>) => JSON.stringify(o);
	const write = (path: string, lines: string[]) => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, lines.join("\n") + "\n", "utf8");
	};

	test("counts only the named action, on the named day", () => {
		withVault((root) => {
			write(auditPath(root), [
				entry({ action: "reason", at: "2026-07-27T01:00:00Z", cost_usd: 0.1 }),
				entry({ action: "reason", at: "2026-07-27T02:00:00Z", cost_usd: 0.25 }),
				entry({ action: "reason", at: "2026-07-26T23:00:00Z", cost_usd: 99 }), // yesterday
				entry({ action: "search", at: "2026-07-27T03:00:00Z", cost_usd: 99 }), // another action
				entry({ action: "recall", at: "2026-07-27T04:00:00Z" }), // no such field
			]);
			assert.equal(Number(sumAuditField(root, "reason", "2026-07-27", "cost_usd").total.toFixed(4)), 0.35);
		});
	});

	test("reads the ROTATED generation too, not just the live log", () => {
		// createAuditor renames the log to .jsonl.1 once it crosses AUDIT_MAX_BYTES.
		// A reader that knows only the live path reports zero for a day that did
		// spend — indistinguishable from "nothing ran", which is the one thing this
		// figure exists to tell apart.
		withVault((root) => {
			write(`${auditPath(root)}.1`, [entry({ action: "reason", at: "2026-07-27T01:00:00Z", cost_usd: 0.5 })]);
			write(auditPath(root), [entry({ action: "reason", at: "2026-07-27T09:00:00Z", cost_usd: 0.25 })]);
			assert.equal(Number(sumAuditField(root, "reason", "2026-07-27", "cost_usd").total.toFixed(4)), 0.75);
		});
	});

	test("a missing log is zero, not a crash", () => {
		withVault((root) => assert.equal(sumAuditField(root, "reason", "2026-07-27", "cost_usd").total, 0));
	});

	test("a torn or hand-edited line is skipped, never fatal", () => {
		// Read for reporting only, so a corrupt line may under-report — but it must
		// never throw and take `health` down with it.
		withVault((root) => {
			write(auditPath(root), [
				entry({ action: "reason", at: "2026-07-27T01:00:00Z", cost_usd: 0.1 }),
				'{"action":"reason","at":"2026-07-27T02:00:00Z","cost_usd":', // truncated
				"",
				"not json at all",
				entry({ action: "reason", at: "2026-07-27T03:00:00Z", cost_usd: "free" }), // wrong type
				entry({ action: "reason", at: "2026-07-27T04:00:00Z", cost_usd: 0.2 }),
			]);
			assert.equal(Number(sumAuditField(root, "reason", "2026-07-27", "cost_usd").total.toFixed(4)), 0.3);
		});
	});

	test("an entry that merely MENTIONS the action is not counted as one", () => {
		// The line is prefiltered on the action's name before parsing, for speed.
		// The parse still has to be what decides.
		withVault((root) => {
			write(auditPath(root), [
				entry({ action: "search", at: "2026-07-27T01:00:00Z", query: "why reason is slow", cost_usd: 99 }),
				entry({ action: "reason", at: "2026-07-27T02:00:00Z", cost_usd: 0.4 }),
			]);
			assert.equal(Number(sumAuditField(root, "reason", "2026-07-27", "cost_usd").total.toFixed(4)), 0.4);
		});
	});

	test("what the auditor actually writes is what this reads", () => {
		// The end-to-end guard: stamp through createAuditor, read through
		// sumAuditField. Nothing hand-rolls the entry shape on either side.
		withVault((root) => {
			const audit = createAuditor(auditPath(root), () => "atlas", () => "2026-07-27T05:00:00Z");
			audit("reason", { cost_usd: 0.6 });
			audit("search", { cost_usd: 5 });
			assert.equal(Number(sumAuditField(root, "reason", "2026-07-27", "cost_usd").total.toFixed(4)), 0.6);
		});
	});
});
