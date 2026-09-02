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

const MODELS_BLOCK_RE = /^models:\n(?:(?![^\s]).*\n?)*/m;
const EMBED_LINE_RE = /^(\s+)embed:[ \t]*(\S.*?)[ \t]*$/m;

/**
 * The outcome of trying to set `models.embed`, kept distinct because the three
 * cases need different handling and two of them produce no write:
 *
 * - `updated` — the key was absent or still held qmd's default, and `content`
 *   is the file to write. Existing vectors are now the wrong dimension, so the
 *   caller MUST force a re-embed; qmd raises a hard error otherwise, and a
 *   query in that state throws rather than degrading.
 * - `already-set` — nothing to do, so re-running is free.
 * - `user-chosen` — someone set a different model deliberately. Never
 *   overwritten: a template supplies a better default, it does not overrule a
 *   choice. The caller reports what it found and leaves it.
 */
export type EmbedModelPatch =
	| { readonly kind: "updated"; readonly content: string }
	| { readonly kind: "already-set" }
	| { readonly kind: "user-chosen"; readonly current: string };

/**
 * Set `models.embed` to `desired` in a qmd config, preserving everything else.
 *
 * Pure so the policy — replace the default, keep a deliberate choice, do
 * nothing when already correct — is testable without a filesystem or a qmd.
 */
export function upsertEmbedModelInYaml(
	content: string,
	desired: string,
): EmbedModelPatch {
	const block = MODELS_BLOCK_RE.exec(content);

	// No `models:` at all. qmd writes one on first use, so this is mainly the
	// hand-written or freshly-templated case; append rather than guess where
	// it belongs.
	if (!block) {
		const separator = content.endsWith("\n") || content.length === 0 ? "" : "\n";
		return {
			kind: "updated",
			content: `${content}${separator}models:\n  embed: ${desired}\n`,
		};
	}

	const embed = EMBED_LINE_RE.exec(block[0]);

	// A `models:` block with no `embed:` key — qmd fills in the rest itself.
	if (!embed) {
		const patched = block[0].replace(/^models:\n/, `models:\n  embed: ${desired}\n`);
		return {
			kind: "updated",
			content:
				content.slice(0, block.index) +
				patched +
				content.slice(block.index + block[0].length),
		};
	}

	const current = embed[2];
	if (current === desired) return { kind: "already-set" };
	if (current !== QMD_DEFAULT_EMBED_MODEL) return { kind: "user-chosen", current };

	const patched = block[0].replace(EMBED_LINE_RE, `$1embed: ${desired}`);
	return {
		kind: "updated",
		content:
			content.slice(0, block.index) +
			patched +
			content.slice(block.index + block[0].length),
	};
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
	writeFileSync(configPath, result.content, "utf-8");
	return true;
}
