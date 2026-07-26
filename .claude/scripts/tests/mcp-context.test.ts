/**
 * Startup context resolution.
 *
 * The theme of every test here is that a WRONG answer at this layer is
 * invisible. A vault root one directory too high, an index belonging to another
 * vault, a memory root that escapes the tree — none of them throw. They all
 * present downstream as "the vault knows nothing", which is the single most
 * expensive failure shape in this whole layer.
 *
 * So the assertions are about refusal and about degradation: what gets rejected
 * despite being written down, and what still boots when a discovery fails.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
	resolveVaultRoot,
	readManifest,
	safeMemoryRoot,
	createContext,
	INSTRUCTIONS,
	PROMPTS,
} from "../lib/mcp-context.ts";

function tmpVault(): string {
	return mkdtempSync(join(tmpdir(), "ctx-"));
}

function put(dir: string, rel: string, content: string): void {
	const full = join(dir, rel);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content, "utf8");
}

const CAPTURE = "---\ndate: 2026-07-26\nsource: mcp-capture\nscope: general\n---\n\n# m\n\nbody\n";

function withVault(fn: (dir: string) => void): void {
	const dir = tmpVault();
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Vault root
// ---------------------------------------------------------------------------

describe("resolving the vault root", () => {
	test("derives two levels up from .claude/scripts/", () => {
		const url = pathToFileURL(join("/some", "vault", ".claude", "scripts", "om-mcp.ts")).href;
		assert.equal(resolveVaultRoot(url, {}), resolve("/some/vault"));
	});

	test("an explicit override wins — one binary must be able to serve any vault", () => {
		const url = pathToFileURL(join("/some", "vault", ".claude", "scripts", "om-mcp.ts")).href;
		assert.equal(resolveVaultRoot(url, { OM_VAULT_PATH: "/elsewhere/other" }), resolve("/elsewhere/other"));
	});

	test("a bare VAULT_PATH is IGNORED — the name is too generic to claim", () => {
		// Regression, found by a real session: `VAULT_PATH` was set on the machine
		// for an unrelated reason, and the server silently served that vault
		// instead of the one its launcher lives in — reporting the wrong vault's
		// config, index and memory count as though they were correct.
		const url = pathToFileURL(join("/a", "b", ".claude", "scripts", "om-mcp.ts")).href;
		assert.equal(resolveVaultRoot(url, { VAULT_PATH: "/somewhere-else" }), resolve("/a/b"));
		assert.equal(resolveVaultRoot(url, { OM_VAULT_PATH: "/deliberate" }), resolve("/deliberate"));
	});

	test("health can tell when an override disagrees with the launcher location", () => {
		withVault((dir) => {
			const ctx = createContext(dir, "/somewhere/else");
			assert.equal(ctx.overriddenFrom, resolve("/somewhere/else"));
			// No disagreement means nothing to report.
			assert.equal(createContext(dir, dir).overriddenFrom, null);
		});
	});

	test("a blank override is ignored rather than resolving to the cwd", () => {
		// `resolve("")` is the process cwd, which would silently serve whatever
		// directory the client happened to launch from.
		const url = pathToFileURL(join("/a", "b", ".claude", "scripts", "om-mcp.ts")).href;
		assert.equal(resolveVaultRoot(url, { OM_VAULT_PATH: "   " }), resolve("/a/b"));
	});
});

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe("reading the manifest", () => {
	test("parses a real manifest", () => {
		withVault((dir) => {
			put(dir, "vault-manifest.json", JSON.stringify({ template: "obsidian-mind", memory_root: "memories" }));
			assert.equal(readManifest(dir).template, "obsidian-mind");
		});
	});

	test("a missing manifest is an empty object, not a throw", () => {
		withVault((dir) => {
			assert.deepEqual(readManifest(dir), {});
		});
	});

	test("a malformed manifest is an empty object, not a throw", () => {
		withVault((dir) => {
			put(dir, "vault-manifest.json", "{ not json");
			assert.deepEqual(readManifest(dir), {});
		});
	});

	test("a manifest that is valid JSON but not an object is still an empty object", () => {
		withVault((dir) => {
			put(dir, "vault-manifest.json", "[1,2,3]");
			assert.deepEqual(readManifest(dir), {});
		});
	});
});

// ---------------------------------------------------------------------------
// Memory root validation — the one with a blast radius
// ---------------------------------------------------------------------------

describe("validating a declared memory root", () => {
	test("an ordinary name is taken as declared", () => {
		assert.equal(safeMemoryRoot("knowledge"), "knowledge");
		assert.equal(safeMemoryRoot("my-memories"), "my-memories");
		assert.equal(safeMemoryRoot("mem_2"), "mem_2");
	});

	test("a traversal is refused — this is the whole reason the check exists", () => {
		// Every capture writes through this value. A root that escapes the vault
		// turns the capture tool into an arbitrary file write.
		assert.equal(safeMemoryRoot(".."), "memories");
		assert.equal(safeMemoryRoot("../../etc"), "memories");
		assert.equal(safeMemoryRoot("../outside"), "memories");
	});

	test("a separator is refused in either style", () => {
		assert.equal(safeMemoryRoot("a/b"), "memories");
		assert.equal(safeMemoryRoot("a\\b"), "memories");
		assert.equal(safeMemoryRoot("/absolute"), "memories");
		assert.equal(safeMemoryRoot("C:\\Windows"), "memories");
	});

	test("empty, blank and non-string values fall back", () => {
		assert.equal(safeMemoryRoot(""), "memories");
		assert.equal(safeMemoryRoot("   "), "memories");
		assert.equal(safeMemoryRoot("."), "memories");
		assert.equal(safeMemoryRoot(null), "memories");
		assert.equal(safeMemoryRoot(undefined), "memories");
		assert.equal(safeMemoryRoot(42), "memories");
		assert.equal(safeMemoryRoot({ root: "x" }), "memories");
	});

	test("a shell metacharacter is refused", () => {
		assert.equal(safeMemoryRoot("mem;rm -rf"), "memories");
		assert.equal(safeMemoryRoot("mem$(x)"), "memories");
	});
});

// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------

describe("building the context", () => {
	test("an unconfigured vault still resolves everything it can", () => {
		withVault((dir) => {
			const ctx = createContext(dir);
			assert.equal(ctx.vaultRoot, dir);
			assert.deepEqual(ctx.manifest, {});
			assert.equal(ctx.memoryRoot, "memories");
			assert.equal(ctx.qmdLauncher, null, "qmd is optional");
			// Derived from the folder name rather than left null: a template that
			// ships one literal gives every install the same store (#137).
			assert.ok(ctx.qmdIndex, "an index name must be derived, never shared by default");
		});
	});

	test("an explicit index pin wins over derivation", () => {
		withVault((dir) => {
			put(dir, "vault-manifest.json", JSON.stringify({ qmd_index: "pinned-name" }));
			assert.equal(createContext(dir).qmdIndex, "pinned-name");
		});
	});

	test("the derived index is per-vault, not a shared literal", () => {
		withVault((a) => {
			withVault((b) => {
				const one = createContext(a).qmdIndex;
				const two = createContext(b).qmdIndex;
				assert.notEqual(one, two, "two vaults sharing an index is exactly #137");
			});
		});
	});

	test("a renamed memory folder is discovered, and the disagreement is visible", () => {
		withVault((dir) => {
			put(dir, "vault-manifest.json", JSON.stringify({ memory_root: "memories" }));
			put(dir, join("knowledge", "2026", "07", "a.md"), CAPTURE);
			const ctx = createContext(dir);
			assert.equal(ctx.memoryRoot, "knowledge");
			assert.equal(ctx.memory.healed, true);
			assert.equal(ctx.memory.configured, "memories");
		});
	});

	test("an unsafe declared root never reaches discovery", () => {
		withVault((dir) => {
			put(dir, "vault-manifest.json", JSON.stringify({ memory_root: "../escape" }));
			const ctx = createContext(dir);
			assert.equal(ctx.memoryRoot, "memories");
			assert.ok(!ctx.memoryRoot.includes(".."));
			assert.ok(!ctx.memoryRoot.includes(sep));
		});
	});

	test("a present qmd launcher is found", () => {
		withVault((dir) => {
			put(dir, join(".claude", "scripts", "qmd-mcp.mjs"), "//");
			assert.ok(createContext(dir).qmdLauncher);
		});
	});
});

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

describe("the injected contract", () => {
	test("carries the prohibition that was measured to hold", () => {
		// A prohibition propagates into the calling session reliably; a positive
		// routing instruction does not. This is the half that actually enforces.
		assert.match(INSTRUCTIONS, /claude\.ai session URLs/);
		assert.match(INSTRUCTIONS, /Claude-Session:/);
		assert.match(INSTRUCTIONS, /Co-Authored-By:/);
	});

	test("tells the session to preserve epistemic qualifiers rather than flatten them", () => {
		assert.match(INSTRUCTIONS, /never/i);
		assert.match(INSTRUCTIONS, /promote an inferred fact/);
	});

	test("stays small — every token is paid by every connecting session", () => {
		assert.ok(
			INSTRUCTIONS.length < 2000,
			`contract is ${INSTRUCTIONS.length} bytes; it is injected into every session in every repo`,
		);
	});

	test("names the tools it tells the session to call", () => {
		// A contract referring to a tool that does not exist is worse than silence.
		for (const tool of ["search", "expand"]) {
			assert.ok(INSTRUCTIONS.includes(tool), `contract references ${tool}`);
		}
	});

	test("prompts are user-invoked and both declare a required argument", () => {
		assert.equal(PROMPTS.length, 2);
		for (const p of PROMPTS) {
			assert.ok(p.name && p.description);
			assert.ok(p.arguments.length >= 1);
			assert.equal(p.arguments[0]!.required, true);
		}
	});
});
