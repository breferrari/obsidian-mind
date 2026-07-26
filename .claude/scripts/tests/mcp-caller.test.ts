/**
 * Caller identity and the outbound boundary.
 *
 * Two things are being protected here and they pull in different directions.
 *
 * Identity must be DERIVED, so a session cannot claim to be a project it is
 * not — that is what makes every scoping rule downstream trustworthy. And the
 * sanitiser must strip local paths out of anything crossing back, because error
 * text lands in the calling session and may be pasted into a commit or an
 * issue, which is the exact leak class this project already shipped once.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	normalizePath,
	rootToPath,
	callerProject,
	isVaultItself,
	sanitize,
	createAuditor,
	auditPath,
	type Root,
} from "../lib/mcp-caller.ts";

const root = (uri: string): Root => ({ uri });

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe("reading the caller's identity from roots", () => {
	test("handles the two- and three-slash file URI forms", () => {
		assert.equal(rootToPath("file:///C:/Dev/atlas"), "C:/Dev/atlas");
		assert.equal(rootToPath("file://C:/Dev/atlas"), "C:/Dev/atlas");
		assert.equal(rootToPath("file:///home/x/atlas"), "home/x/atlas");
	});

	test("percent-encoding is decoded, and a malformed escape does not throw", () => {
		assert.equal(rootToPath("file:///C:/Dev/my%20app"), "C:/Dev/my app");
		assert.equal(rootToPath("file:///C:/Dev/100%"), "C:/Dev/100%");
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
});

describe("recognising the vault itself", () => {
	test("a session whose root IS the vault is recognised", () => {
		assert.equal(isVaultItself("C:/Dev/myvault", [root("file:///C:/Dev/myvault")]), true);
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
		const audit = createAuditor(join("Z:", "definitely", "not", "here.jsonl"), () => "x");
		assert.doesNotThrow(() => audit("search", { query: "q" }));
	});

	test("the log lands inside the vault, where the repo can ignore it", () => {
		assert.equal(auditPath("C:/v"), join("C:/v", ".claude", "om-mcp-audit.jsonl"));
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
