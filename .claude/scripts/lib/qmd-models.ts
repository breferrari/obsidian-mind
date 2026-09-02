/**
 * Which embedding model this vault's qmd index uses, and how that choice is
 * written into qmd's YAML config without disturbing anything else in it.
 *
 * qmd picks its embedder as `config.embed || QMD_EMBED_MODEL || <its default>`,
 * and — this is the part that decides the shape here — it MATERIALISES its
 * defaults into the config file the first time it touches an index. So the
 * environment variable is only ever read before that first write, which for a
 * template means never reliably. The config file is the only durable surface.
 *
 * qmd owns that file and rewrites it as collections change, so editing it is
 * expected rather than intrusive. The edit is still surgical: it touches one
 * key and leaves collections, patterns, ignore lists and the context string
 * exactly as they were.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { warn } from "./hook-io.ts";

/**
 * qmd's own default embedder, as of 2.8.3. Recognised so the upsert can tell
 * "nobody chose this" from "somebody chose this" — the first is ours to
 * replace, the second is not.
 */
export const QMD_DEFAULT_EMBED_MODEL =
	"hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";

/**
 * Every embedder qmd has shipped as its default, not just the current one.
 *
 * The failure this exists for is silent in both directions. qmd materialises
 * its default into the config on first use, so when a future version ships a
 * different one it lands in configs unasked — and matching only the current
 * default would then read that as somebody's deliberate choice and stop
 * applying this template's embedder, with no error and no failing test. Worse,
 * the `warn()` below goes to stderr, and the SessionStart self-heal spawns the
 * bootstrap with stdio ignored, so nothing surfaces anywhere.
 *
 * Add to this set rather than replacing: a config still holding an older qmd
 * default is exactly as unchosen as one holding the current one.
 */
const QMD_SHIPPED_DEFAULTS: ReadonlySet<string> = new Set([
	// The only one so far: verified identical in 2.1.0, 2.5.3 and 2.8.3.
	QMD_DEFAULT_EMBED_MODEL,
]);

/**
 * What this template uses instead.
 *
 * Measured on a 684-document vault against 211 human-labelled retrieval pairs,
 * with the query path otherwise untouched: rank-1 0.299 → 0.469 and found@5
 * 0.521 → 0.758, McNemar exact p < 0.0001 over 66 discordant pairs. Replicated
 * on a second, independently written vault at rank-1 0.650 → 0.950 (p =
 * 0.0003), which is what distinguishes an embedder that suits vaults from one
 * that happened to suit the first corpus tried.
 *
 * It costs ~13ms a query and roughly doubles a full index build. Reranking is
 * NOT the cheaper substitute: on the default embedder reranking is a large
 * significant gain, on this one it is not significant on rank-1 (p = 0.185) —
 * it had been compensating for the embedder — and this model without a
 * reranker beats the default model with one at an eighth of the latency.
 */
export const PREFERRED_EMBED_MODEL =
	"hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf";

/**
 * A `models:` key in any spelling at all. Used to decide whether appending a
 * block is safe — never to locate one for editing.
 */
const MODELS_KEY_RE = /^models:/m;

/**
 * The block-style `models:` mapping, which is the only shape this can edit: the
 * header (with an optional trailing comment) plus every following line that is
 * indented or blank.
 */
const MODELS_BLOCK_RE = /^models:[ \t]*(?:#[^\n]*)?\n(?:(?![^\s]).*\n?)*/m;

/**
 * An `embed:` entry inside that block. The value is captured loosely — empty,
 * quoted and comment-suffixed values all match — because failing to match here
 * means inserting a SECOND `embed:` key, which is a corrupt file rather than a
 * missed improvement.
 */
const EMBED_LINE_RE = /^([ \t]+)embed:[ \t]*(.*?)[ \t]*$/m;

/**
 * Reduce a captured YAML scalar to the string it denotes: drop an inline
 * comment, then one layer of surrounding quotes.
 *
 * Without this, `embed: "<qmd's default>"` and `embed: <qmd's default> # note`
 * both compare unequal to the default and get classified as somebody's
 * deliberate choice — so the vault silently keeps the worse embedder and is
 * told its model is "neither qmd's default nor this template's" when it is
 * exactly qmd's default.
 */
function yamlScalar(raw: string): string {
	let v = raw.trim();
	const comment = v.search(/\s#/);
	if (comment !== -1) v = v.slice(0, comment).trim();
	const quoted =
		(v.startsWith('"') && v.endsWith('"')) ||
		(v.startsWith("'") && v.endsWith("'"));
	return quoted && v.length >= 2 ? v.slice(1, -1) : v;
}

/**
 * The outcome of trying to set `models.embed`. Three of the four produce no
 * write, and they are kept distinct because they need different handling:
 *
 * - `updated` — the key was absent or still held qmd's default, and `content`
 *   is the file to write. Existing vectors are now the wrong dimension, so the
 *   caller MUST force a re-embed; qmd raises a hard error otherwise, and a
 *   query in that state throws rather than degrading.
 * - `already-set` — nothing to do, so re-running is free.
 * - `user-chosen` — somebody set a different model deliberately. Never
 *   overwritten: a template supplies a better default, it does not overrule a
 *   choice.
 * - `unsupported` — there is a `models:` key this cannot edit safely (flow
 *   style, say). Refusing is the whole point: the alternative is appending a
 *   second `models:` key, and a duplicate key makes the file unparseable, which
 *   takes qmd's collections and all search down with it.
 */
export type EmbedModelPatch =
	| { readonly kind: "updated"; readonly content: string }
	| { readonly kind: "already-set" }
	| { readonly kind: "user-chosen"; readonly current: string }
	| { readonly kind: "unsupported"; readonly reason: string };

/** Exactly one top-level `models:` and at most one `embed:` inside it. */
function isWellFormed(content: string): boolean {
	const models = content.match(/^models:/gm) ?? [];
	if (models.length !== 1) return false;
	const block = MODELS_BLOCK_RE.exec(content);
	return (block?.[0].match(/^[ \t]+embed:/gm) ?? []).length <= 1;
}

/**
 * Set `models.embed` to `desired` in a qmd config, preserving everything else.
 *
 * Pure, so the policy — replace the default, keep a deliberate choice, do
 * nothing when already correct, refuse what it cannot edit — is testable
 * without a filesystem or a qmd.
 *
 * CRLF is normalised for matching and restored on the way out: a config written
 * on Windows otherwise misses every anchored pattern here, and the miss lands
 * in the append branch rather than failing visibly.
 */
export function upsertEmbedModelInYaml(
	content: string,
	desired: string,
): EmbedModelPatch {
	const crlf = content.includes("\r\n");
	const text = crlf ? content.replace(/\r\n/g, "\n") : content;
	const restore = (out: string): string => (crlf ? out.replace(/\n/g, "\r\n") : out);

	const block = MODELS_BLOCK_RE.exec(text);

	if (!block) {
		// A `models:` key that did not parse as an editable block. Appending here
		// would duplicate the key and make the file unloadable, so stop instead.
		if (MODELS_KEY_RE.test(text)) {
			return {
				kind: "unsupported",
				reason: "a `models:` key that is not a block mapping this can edit",
			};
		}
		const separator = text.endsWith("\n") || text.length === 0 ? "" : "\n";
		const out = `${text}${separator}models:\n  embed: ${desired}\n`;
		return isWellFormed(out)
			? { kind: "updated", content: restore(out) }
			: { kind: "unsupported", reason: "appending a models block would not be well-formed" };
	}

	const embed = EMBED_LINE_RE.exec(block[0]);
	const splice = (patchedBlock: string): EmbedModelPatch => {
		const out =
			text.slice(0, block.index) +
			patchedBlock +
			text.slice(block.index + block[0].length);
		// The guard, not a formality: every corruption this function could cause
		// shows up as a duplicate key, so refuse to hand one back.
		return isWellFormed(out)
			? { kind: "updated", content: restore(out) }
			: { kind: "unsupported", reason: "the edit would have produced a duplicate key" };
	};

	if (!embed) {
		return splice(block[0].replace(/^models:/, `models:\n  embed: ${desired}`).replace(/^(models:\n  embed: [^\n]*)\n[ \t]*(?:#[^\n]*)?\n/, "$1\n"));
	}

	// An `embed:` key with no value is unset, not chosen — the improvement
	// applies, and the line is replaced rather than a second one inserted.
	const current = yamlScalar(embed[2] ?? "");
	if (current === desired) return { kind: "already-set" };
	if (current !== "" && !QMD_SHIPPED_DEFAULTS.has(current)) {
		return { kind: "user-chosen", current };
	}
	return splice(block[0].replace(EMBED_LINE_RE, `$1embed: ${desired}`));
}

/**
 * Apply {@link upsertEmbedModelInYaml} to a config on disk.
 *
 * Returns true when the file changed, which is exactly the condition under
 * which the caller has to force a re-embed. A missing config is not an error:
 * qmd has simply not created it yet, and the next bootstrap run will.
 */
export function writeQmdEmbedModel(
	configPath: string,
	desired: string = PREFERRED_EMBED_MODEL,
): boolean {
	let before: string;
	try {
		before = readFileSync(configPath, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			warn(`QMD config not found at ${configPath}; embedding model not set.`);
			return false;
		}
		throw err;
	}
	const result = upsertEmbedModelInYaml(before, desired);
	if (result.kind === "already-set") return false;
	if (result.kind === "user-chosen") {
		warn(
			`QMD embedding model is set to ${result.current}, which is neither qmd's default nor this template's; leaving it alone.`,
		);
		return false;
	}
	if (result.kind === "unsupported") {
		warn(
			`QMD config at ${configPath} has ${result.reason}; embedding model not set. Set models.embed to ${desired} by hand, then run \`qmd embed -f\`.`,
		);
		return false;
	}
	writeFileSync(configPath, result.content, "utf-8");
	return true;
}
