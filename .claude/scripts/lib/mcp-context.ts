/**
 * Everything the MCP server needs to know about the vault it is serving,
 * resolved once at startup.
 *
 * Split out of the server for one reason: this is the layer where a wrong
 * answer is INVISIBLE. A vault root pointing one directory too high, an index
 * name belonging to a different vault, a memory root that no longer exists —
 * none of them error. They all present as "the vault knows nothing", and three
 * separate defects of exactly that shape were found only by installing the
 * prototype against a vault other than the author's.
 *
 * So every value here is either derived from the vault itself, validated before
 * use, or reported by `health()`. Nothing is assumed, and nothing that fails
 * validation is trusted just because it was written down.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveQmdIndex } from "./session-start.ts";
import { MEMORY_ROOT } from "./memory-write.ts";
import { discoverMemoryRoot, discoverQmdLauncher, type MemoryRootInfo } from "./memory-discover.ts";

export interface VaultContext {
	/** Absolute path to the vault this server serves. */
	readonly vaultRoot: string;
	/** Parsed `vault-manifest.json`, or `{}` when absent or malformed. */
	readonly manifest: Record<string, unknown>;
	/** The qmd named index this vault owns, or null for qmd's global default. */
	readonly qmdIndex: string | null;
	/** Where memories actually live, and whether that disagreed with config. */
	readonly memory: MemoryRootInfo;
	/** Convenience: `memory.root`. */
	readonly memoryRoot: string;
	/** Path to this install's qmd MCP launcher, or null when qmd is absent. */
	readonly qmdLauncher: string | null;
	/** Set when OM_VAULT_PATH pointed somewhere other than the launcher location. */
	readonly overriddenFrom: string | null;
}

/**
 * Resolve the vault root.
 *
 * Layout assumption, identical to `qmd-mcp.mjs`: the server lives at
 * `<vault>/.claude/scripts/`, so the vault is two levels up. The env override
 * exists because one binary should be able to serve any vault — "which vault?"
 * is a config answer, never a guess — and because a consuming repo registering
 * this server may point at a vault that is nowhere near it on disk.
 */
export function resolveVaultRoot(metaUrl: string, env: NodeJS.ProcessEnv = process.env): string {
	// `OM_VAULT_PATH` only. A bare `VAULT_PATH` was also honoured, and that name
	// is too generic to claim: it is set for unrelated reasons on real machines,
	// and the result was a server silently serving a DIFFERENT vault than the
	// launcher it was started from — reporting that vault's config as if correct.
	const override = env.OM_VAULT_PATH;
	if (override && override.trim()) return resolve(override.trim());
	return resolve(dirname(fileURLToPath(metaUrl)), "..", "..");
}

/**
 * The vault the launcher's own location implies, ignoring any override. Used by
 * `health` to say when the two disagree.
 */
export function derivedVaultRoot(metaUrl: string): string {
	return resolve(dirname(fileURLToPath(metaUrl)), "..", "..");
}

/** Read and parse the manifest. A malformed manifest is `{}`, never a throw. */
export function readManifest(vaultRoot: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(vaultRoot, "vault-manifest.json"), "utf8"));
		// `typeof [] === "object"`, so the array case needs its own guard or a
		// manifest of `[1,2,3]` is handed back as if it were a record.
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/**
 * Validate a declared `memory_root` before anything writes through it.
 *
 * A memory root carrying a separator or a traversal would turn every capture
 * into an arbitrary write anywhere on disk. The rule is deliberately stricter
 * than "does it resolve inside the vault": a single path segment of ordinary
 * filename characters, or the default. Anything else is not repaired or
 * rejected loudly — it falls back, because a capture landing in the default
 * folder is recoverable and a capture landing outside the vault is not.
 */
export function safeMemoryRoot(declared: unknown, fallback: string = MEMORY_ROOT): string {
	if (typeof declared !== "string") return fallback;
	const value = declared.trim();
	if (!value || value === "." || value === "..") return fallback;
	if (!/^[\w.-]+$/.test(value)) return fallback;
	return value;
}

/**
 * Build the context. Every discovery is individually guarded: a failure in one
 * must degrade that one capability, never take down startup. A server that
 * refuses to boot because `health` could not be computed is strictly worse than
 * one that boots and reports the problem.
 */
export function createContext(vaultRoot: string, derivedFrom?: string): VaultContext {
	const manifest = readManifest(vaultRoot);

	// Route through the canonical resolver. Four other callers already share it
	// (SessionStart, the refresh worker, the MCP wrapper, the bootstrap script)
	// and they fail SILENTLY when they disagree — one writes to a store another
	// never reads, which surfaces only as "0 documents". This server is the fifth.
	let qmdIndex: string | null = null;
	try {
		const raw = readFileSync(join(vaultRoot, "vault-manifest.json"), "utf8");
		qmdIndex = resolveQmdIndex(raw, vaultRoot);
	} catch {
		qmdIndex = resolveQmdIndex(null, vaultRoot);
	}

	const configured = safeMemoryRoot(manifest.memory_root);
	let memory: MemoryRootInfo;
	try {
		memory = discoverMemoryRoot(vaultRoot, configured);
	} catch {
		memory = {
			root: configured,
			source: "configured",
			memories: 0,
			healed: false,
			configured,
			split: null,
		};
	}

	let qmdLauncher: string | null = null;
	try {
		qmdLauncher = discoverQmdLauncher(vaultRoot).path;
	} catch {
		qmdLauncher = null;
	}

	const overriddenFrom =
		derivedFrom && resolve(derivedFrom) !== resolve(vaultRoot) ? resolve(derivedFrom) : null;
	return { vaultRoot, manifest, qmdIndex, memory, memoryRoot: memory.root, qmdLauncher, overriddenFrom };
}

/**
 * The contract. This is the payload that makes tier 0 worth building: it lands
 * in the system prompt of every session that connects, in any repository.
 *
 * Kept deliberately short. Every token here is paid by every session, so it
 * carries only rules that change behaviour OUTSIDE the vault — not the vault's
 * own filing conventions, which are useless to a session in another repo.
 *
 * Note what this does and does not attempt. The PROHIBITION at the end holds
 * reliably: measured, a session refused a direct request and an authority
 * override rather than break it. The "when to use it" section is ADVISORY and
 * gets skipped whenever a nearer source exists — which is why the install also
 * requires a pointer in the consuming repo's own CLAUDE.md. A server can stop a
 * session doing something; it cannot make one go looking.
 */
export const INSTRUCTIONS: string = [
	"You have access to the user's personal knowledge vault through this server.",
	"",
	"WHEN TO USE IT: before answering questions about past decisions, prior art, why",
	"something is the way it is, or what the user already concluded, call search.",
	"The vault is the record; your memory of this conversation is not.",
	"",
	"The vault also exposes notes as MCP RESOURCES. List them when you want to see what",
	"knowledge exists before searching blindly, and read one directly when its title",
	"already answers the question — that is cheaper and more exact than a search.",
	"Once you know a specific note, call expand to see what it links to and what",
	"links back, rather than searching again.",
	"",
	"HOW TO TREAT WHAT YOU FIND: cite the note path you used. Vault notes carry",
	"'as of YYYY-MM-DD' markers on volatile facts and (TBC)/(inferred) markers on",
	"unverified ones. Preserve those qualifiers when you repeat a claim; never",
	"promote an inferred fact to a stated one. If a note is months old and the claim",
	"is volatile, say so rather than asserting it.",
	"",
	"NEVER put agent-session artifacts into anything that lands in a repository:",
	"no claude.ai session URLs, no 'Claude-Session:' trailers, no local absolute",
	"paths. Not in commit messages, PR or issue bodies, review comments, or files.",
	"'Co-Authored-By:' is fine and wanted; the session URL is not.",
].join("\n");

export interface PromptDef {
	readonly name: string;
	readonly description: string;
	readonly arguments: { name: string; description: string; required: boolean }[];
}

/**
 * Vault workflows as slash commands in the calling session.
 *
 * These exist because they are USER-invoked. Everything else on this server
 * depends on the model deciding to call it, and the measured finding is that it
 * often does not when a nearer source is available. A prompt bypasses that
 * entirely: the human chooses, so the vault is consulted with certainty.
 */
export const PROMPTS: readonly PromptDef[] = [
	{
		name: "recall_topic",
		description: "Search the vault and summarise what is already known about a topic, with citations.",
		arguments: [{ name: "topic", description: "What to recall", required: true }],
	},
	{
		name: "prior_art",
		description: "Check the vault for prior decisions on a question before deciding it again.",
		arguments: [{ name: "question", description: "The decision being faced", required: true }],
	},
];
