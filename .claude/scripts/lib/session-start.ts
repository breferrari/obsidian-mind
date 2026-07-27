/**
 * Pure helpers for session-start context assembly — extracted so the
 * formatting logic is unit-testable without spawning git, reading the file
 * system, or invoking the Obsidian CLI.
 */

import { basename, join, resolve } from "node:path";

import { escapeRegex } from "./regex.ts";

export function take(stdout: string, n: number): string {
	return stdout.split("\n").slice(0, n).join("\n");
}

/**
 * Injection-size meter line: eager-layer bloat becomes visible the day it
 * starts. kB = 1000 bytes, one decimal. Negative/NaN guard to 0.0kB — the
 * meter must never be the thing that breaks the hook.
 *
 * With a budget, the meter also reports the ceiling and names any section
 * that was collapsed to stay under it. Silence about a collapse would be
 * worse than the bloat: a session would silently lose context and never
 * know. Called with one argument the output is byte-identical to before.
 */
export function formatInjectionSize(
	bytes: number,
	opts?: {
		readonly budgetBytes?: number | undefined;
		readonly collapsed?: readonly string[] | undefined;
	},
): string {
	const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
	const size = `${(safe / 1000).toFixed(1)}kB`;

	const budget = opts?.budgetBytes;
	if (budget === undefined || !Number.isFinite(budget) || budget <= 0) {
		return `_context injected: ${size}_`;
	}

	const ceiling = `${(budget / 1000).toFixed(1)}kB budget`;
	const collapsed = opts?.collapsed ?? [];
	if (collapsed.length === 0) {
		return `_context injected: ${size} / ${ceiling}_`;
	}
	return `_context injected: ${size} / ${ceiling} — collapsed: ${collapsed.join(", ")}_`;
}

/**
 * One assembled section of the eager layer, with what it costs and what it
 * degrades to when the injection is over budget.
 *
 * `priority` orders SURRENDER, not importance: the highest number is given
 * up first. A section with no `fallback` is load-bearing and never dropped
 * (identity, the date header) regardless of priority.
 */
export type BudgetSection = {
	/** Section heading, e.g. "### Vault File Listing". Empty for preamble. */
	readonly header: string;
	readonly body: string;
	readonly priority: number;
	readonly fallback?: string | undefined;
};

export type BudgetResult = {
	readonly text: string;
	readonly bytes: number;
	/** Headers (heading markup stripped) that were degraded, in drop order. */
	readonly collapsed: readonly string[];
};

function renderSections(sections: readonly BudgetSection[]): string {
	return sections
		.map((s) => (s.header === "" ? s.body : `${s.header}\n${s.body}`))
		.join("\n\n");
}

/**
 * Hold the eager layer under a byte ceiling by degrading the cheapest-to-lose
 * sections to their pointers, highest `priority` first, until it fits.
 *
 * Why bytes and not lines: the pre-existing caps in this file (`take`,
 * `formatActiveWork`, `collectOpenTasks`) are all LINE caps, and a line cap
 * cannot bound an injection — shortening entries just slides the window
 * deeper and refills it. Only a byte budget actually holds.
 *
 * Degradation is never silent truncation: a section is replaced whole by its
 * fallback pointer, so the content is missing but its existence is not.
 *
 * A non-finite or non-positive budget is a no-op — as with the size meter,
 * the budget must never be the thing that breaks the hook.
 */
export function applyInjectionBudget(
	sections: readonly BudgetSection[],
	budgetBytes: number,
): BudgetResult {
	const render = (s: readonly BudgetSection[]): BudgetResult => ({
		text: renderSections(s),
		bytes: Buffer.byteLength(renderSections(s), "utf-8"),
		collapsed: [],
	});

	if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) return render(sections);

	let current = [...sections];
	if (render(current).bytes <= budgetBytes) return render(current);

	// Candidates are only those that can degrade, surrendered worst-first.
	const order = current
		.map((s, i) => ({ s, i }))
		.filter(({ s }) => s.fallback !== undefined && s.fallback !== s.body)
		.sort((a, b) => b.s.priority - a.s.priority || a.i - b.i);

	const collapsed: string[] = [];
	for (const { i } of order) {
		const target = current[i];
		if (target === undefined) continue;
		current[i] = { ...target, body: target.fallback ?? target.body };
		collapsed.push(target.header.replace(/^#+\s*/, ""));
		if (Buffer.byteLength(renderSections(current), "utf-8") <= budgetBytes) break;
	}

	const text = renderSections(current);
	return { text, bytes: Buffer.byteLength(text, "utf-8"), collapsed };
}

/**
 * Collapse a FLAT directory holding more than `threshold` notes to a single
 * count line.
 *
 * Replaces a hardcoded folder list: a fixed list only ever collapses the
 * folders someone remembered to name, so a vault grows past the ceiling
 * through whichever directory nobody listed. A threshold cannot go stale as
 * a vault evolves.
 *
 * `hasSubdirs` is the guard that makes this safe. Collapsing on recursive
 * subtree count folds whole TREES — `projects/`, `brain/`, `work/` all
 * vanish behind one line and the vault's shape becomes invisible, which is
 * far worse than the bytes it saves. The signal we actually want is flat
 * bulk: a folder of same-shaped sibling notes (people, archives, captures)
 * whose names are retrievable on demand. Structure is navigation and is
 * kept; flat bulk is noise and is folded. Anything the threshold declines
 * to fold is still caught by the byte budget — two mechanisms, two jobs.
 */
export const DEFAULT_LISTING_COLLAPSE_THRESHOLD = 12;

export function shouldCollapseDir(
	noteCount: number,
	threshold: number,
	alwaysCollapse: readonly string[],
	posixPath: string,
	hasSubdirs: boolean,
): boolean {
	if (alwaysCollapse.includes(posixPath)) return true;
	if (hasSubdirs) return false;
	if (!Number.isFinite(threshold) || threshold <= 0) return false;
	return noteCount > threshold;
}

/** The one-line stand-in for a collapsed directory. Shape predates the threshold. */
export function formatCollapsedDir(posixPath: string, noteCount: number): string {
	return `./${posixPath}/ — ${noteCount} notes (listing collapsed — Glob or QMD on demand)`;
}

function parsePositiveIntField(
	manifestJson: string | null,
	field: string,
): number | null {
	if (manifestJson === null) return null;
	try {
		const parsed = JSON.parse(manifestJson) as unknown;
		if (parsed !== null && typeof parsed === "object" && field in parsed) {
			const value = (parsed as Record<string, unknown>)[field];
			if (typeof value === "number" && Number.isInteger(value) && value > 0) {
				return value;
			}
		}
	} catch {
		/* malformed manifest → treat as missing */
	}
	return null;
}

/** `eager_layer_budget_bytes` from the manifest; null when unset or invalid. */
export function parseInjectionBudget(manifestJson: string | null): number | null {
	return parsePositiveIntField(manifestJson, "eager_layer_budget_bytes");
}

/** `listing_collapse_threshold` from the manifest; null when unset or invalid. */
export function parseListingCollapseThreshold(
	manifestJson: string | null,
): number | null {
	return parsePositiveIntField(manifestJson, "listing_collapse_threshold");
}

/**
 * Local-time date header matching `date +%Y-%m-%d` followed by the weekday
 * name. Separate from `new Date()` so tests can pass a fixed date.
 */
export function formatDateHeader(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	const weekday = d.toLocaleDateString("en-US", { weekday: "long" });
	return `${y}-${m}-${day} (${weekday})`;
}

/**
 * Quote one value for the POSIX shell syntax used by `CLAUDE_ENV_FILE`.
 *
 * Single quotes make every character literal except `'` itself, so this needs
 * exactly one escape rule instead of the five a double-quoted string would
 * need (`$`, backtick, `"`, `\`, newline) — and it sidesteps the shell-to-shell
 * differences in how backslash is treated inside double quotes.
 *
 * The close/escape/reopen sequence (`'\''`) is the only way to carry a literal
 * apostrophe through a single-quoted string. Same algorithm as Python's
 * `shlex.quote`, minus its cosmetic "skip quoting when already safe" branch:
 * quoting unconditionally costs a few bytes and removes a regex that could be
 * wrong.
 *
 * Prefer `formatEnvExport` over calling this directly — see the note there.
 */
export function quoteForPosixShell(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** POSIX portable environment variable name. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Build one complete `export NAME='value'` line, newline included.
 *
 * This exists so no call site has to *remember* to quote. `quoteForPosixShell`
 * gives you a safe tool but leaves the unsafe one within reach: a template
 * literal like `export FOO="${bar}"` is still the shortest thing to type, and
 * that is exactly the shape that shipped a command-execution bug here (#145).
 * Owning the whole line removes the choice — there is nothing left to forget.
 * `tests/session-start.test.ts` locks the entry script to this function so a
 * hand-rolled export cannot quietly come back.
 *
 * Throws on a name the shell could not accept. The call site treats env-file
 * persistence as best-effort and already swallows failures, so a bad name
 * degrades to "not persisted" rather than a corrupt env file or a dead hook.
 */
export function formatEnvExport(name: string, value: string): string {
	if (!ENV_NAME_PATTERN.test(name)) {
		throw new Error(`refusing to write unsafe env var name: ${JSON.stringify(name)}`);
	}
	return `export ${name}=${quoteForPosixShell(value)}\n`;
}

/**
 * Format the "Active Work" section from a list of filenames in work/active.
 * Strips `.md`, keeps the first `limit`, returns "(none)" for empty input.
 */
export function formatActiveWork(
	filenames: readonly string[],
	limit: number,
): string {
	const names = filenames
		.filter((f) => isMarkdownFilename(f))
		.map((f) => f.replace(/\.md$/i, ""))
		.slice(0, limit);
	return names.length > 0 ? names.join("\n") : "(none)";
}

/**
 * Format the "Recent Changes" section from raw `git log --oneline` output.
 * Strips blank lines, keeps the first `limit`, falls back to
 * "(no git history)" when empty (matching the legacy shell message).
 */
export function formatRecentChanges(gitOutput: string, limit: number): string {
	const lines = gitOutput
		.split("\n")
		.filter((l) => l.length > 0)
		.slice(0, limit);
	return lines.length > 0 ? lines.join("\n") : "(no git history)";
}

/**
 * Return true if a path (relative, using "/" separators) falls under any
 * of the supplied skip prefixes. A prefix like ".git" matches ".git" and
 * ".git/anything" but not ".github" (exact segment boundary).
 */
export function isSkippedPath(
	pathRel: string,
	skipPrefixes: readonly string[],
): boolean {
	return skipPrefixes.some(
		(p) => pathRel === p || pathRel.startsWith(p + "/"),
	);
}

/**
 * Root-level directories that hold machinery, never vault notes: VCS
 * internals, editor and agent config, the ShardMind engine's own tree,
 * installed dependencies.
 *
 * Shared because two consumers of the same idea drifted apart. The oversize
 * scan already knew the full set while the SessionStart listing skipped only
 * a four-entry subset, so an *installed* vault walked `.shardmind/` and
 * injected the engine's cached template copy plus every pre-update backup
 * snapshot as if they were the user's notes (#156). One list, so the next
 * machinery directory is hidden from both the moment it is added here.
 *
 * Callers append their own list-specific entries rather than editing this
 * one: `thinking/` is hidden from the listing but still size-scanned, and
 * `templates/` is the reverse. Only what is machinery for BOTH belongs here.
 *
 * Note `.github` earns its own entry — `isSkippedPath` matches on segment
 * boundaries, so `.git` deliberately does not cover it.
 */
export const MACHINERY_DIRS: readonly string[] = [
	".git",
	".github",
	".obsidian",
	".claude",
	".claude-plugin",
	".codex",
	".gemini",
	".shardmind",
	".qmd",
	"node_modules",
];

/**
 * Find the closing `---` delimiter of a YAML frontmatter block. The input
 * is assumed to start with `---` (caller checks). Returns the index of the
 * newline before the closing delimiter, or -1 if the block is unterminated.
 *
 * Matches only a full delimiter line (`\n---\n`, `\n---\r\n`, or `\n---` at
 * EOF) so body content like `---foo` after a newline is not treated as the
 * terminator.
 */
function findFrontmatterEnd(content: string): number {
	const m = content.slice(3).match(/\n---(?:\r?\n|$)/);
	return m && m.index !== undefined ? m.index + 3 : -1;
}

/**
 * Extract a string value for `field` from YAML frontmatter at the top of
 * a markdown document. Supports quoted ("..."), single-quoted ('...'),
 * and bare values on the same line as the key. Returns null when the
 * frontmatter block or field is absent.
 *
 * This is a deliberately small parser — just enough for one-line string
 * fields like `description:`. Multi-line/block YAML is out of scope.
 * Handles CRLF line endings and escapes regex metacharacters in `field`.
 */
export function extractFrontmatterField(
	content: string,
	field: string,
): string | null {
	if (!content.startsWith("---")) return null;
	const end = findFrontmatterEnd(content);
	if (end === -1) return null;
	const fm = content.slice(3, end);
	const re = new RegExp(
		`^${escapeRegex(field)}:[ \\t]*(.*?)[ \\t]*\\r?$`,
		"m",
	);
	const m = fm.match(re);
	if (!m) return null;
	const raw = m[1] ?? "";
	if (raw === "") return null;
	if (
		(raw.startsWith('"') && raw.endsWith('"')) ||
		(raw.startsWith("'") && raw.endsWith("'"))
	) {
		return raw.slice(1, -1);
	}
	return raw;
}

/**
 * Return the body of a markdown document with its leading YAML frontmatter
 * stripped. If there's no frontmatter block, returns the input unchanged.
 * Handles both LF and CRLF delimiters.
 */
export function stripFrontmatter(content: string): string {
	if (!content.startsWith("---")) return content;
	const end = findFrontmatterEnd(content);
	if (end === -1) return content;
	const rest = content.slice(end);
	const m = rest.match(/^\n---(\r?\n|$)/);
	return m ? rest.slice(m[0].length) : rest;
}

/**
 * True if the body contains at least one list item with text content —
 * i.e. a bullet like `- foo`, not a bare `-` placeholder. Brain topic
 * notes are list-shaped by template, so this is the clearest signal of
 * "has the user actually added anything here yet?"
 */
export function hasBrainContent(body: string): boolean {
	return /^[ \t]*[-*+][ \t]+\S.*$/m.test(body);
}

/**
 * Restricted character set for `qmd_index`. The value ends up in both CLI
 * argv and a filesystem path (`~/.cache/qmd/<name>.sqlite`), so path
 * separators, parent-dir refs, whitespace, and shell metacharacters must
 * not be accepted. Mirrors the shape of npm package names / git branch
 * segments: alnum + dot + dash + underscore, must start with an alnum.
 */
const QMD_INDEX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * True when `value` is a string that's safe to use as a qmd named index.
 * Exported so callers that read the manifest from other surfaces (the MCP
 * wrapper, the bootstrap script) can apply the same rule.
 */
export function isValidQmdIndex(value: unknown): value is string {
	return typeof value === "string" && QMD_INDEX_PATTERN.test(value);
}

/**
 * Extract the `qmd_index` string from a `vault-manifest.json` source. Returns
 * the configured named index (so QMD's storage is scoped to this vault) or
 * null when the manifest is absent, malformed, missing the field, or the
 * value fails validation (path separators, whitespace, empty, etc.).
 *
 * Kept as a pure helper so the caller can own the fs read and tests can pass
 * fixture strings. A null return means "use QMD's default global index" —
 * backwards-compatible with forks that haven't adopted the field yet.
 */
export function parseQmdIndex(manifestJson: string | null): string | null {
	if (manifestJson === null) return null;
	try {
		const parsed = JSON.parse(manifestJson) as unknown;
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			"qmd_index" in parsed
		) {
			const value = (parsed as Record<string, unknown>)["qmd_index"];
			if (isValidQmdIndex(value)) return value;
		}
	} catch {
		/* malformed manifest → treat as missing */
	}
	return null;
}

/**
 * Derive a qmd index name from the vault's own directory name.
 *
 * The shipped manifest leaves `qmd_index` empty because the template is one
 * package installed many times — any literal it ships is identical in every
 * vault, so two vaults on one machine share a single SQLite store, search
 * bleeds across them, and re-indexing one clobbers the other (#137). The
 * install location is the only per-vault identity available without asking
 * the user a question, and it exists on both install paths.
 *
 * The slug rules mirror ShardMind's `slugifyVaultName` (shardmind#143)
 * deliberately: if a future engine-side substitution ever bakes the name in,
 * it resolves to the same string this derives, so the two mechanisms cannot
 * disagree about which store a vault owns.
 *
 * Returns null when the folder name has no usable characters (e.g. a purely
 * non-Latin name), so the caller falls back rather than emitting a broken
 * index name.
 */
export function deriveQmdIndex(vaultRoot: string): string | null {
	const slug = basename(resolve(vaultRoot))
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[^a-z0-9]+|[-._]+$/g, "");
	return isValidQmdIndex(slug) ? slug : null;
}

/**
 * Extract a validated `template` name from a manifest source — the shared
 * package identity, and the last-resort index name when a vault has neither
 * a pin nor a derivable folder slug.
 */
function parseTemplateName(manifestJson: string | null): string | null {
	if (manifestJson === null) return null;
	try {
		const parsed = JSON.parse(manifestJson) as unknown;
		if (parsed !== null && typeof parsed === "object") {
			const value = (parsed as Record<string, unknown>)["template"];
			if (isValidQmdIndex(value)) return value;
		}
	} catch {
		/* malformed manifest → treat as missing */
	}
	return null;
}

/**
 * The index name this vault owns, in precedence order:
 *
 *   1. an explicit `qmd_index` pin,
 *   2. the vault folder name, slugified,
 *   3. the manifest `template` name — shared across installs, so it
 *      reintroduces the collision #137 fixes, but a working shared store
 *      beats silently indexing somewhere nobody reads.
 *
 * Every caller MUST route through here. There are four (SessionStart, the
 * mid-session refresh worker, the MCP wrapper, the bootstrap script) and they
 * do not fail loudly when they disagree — one writes to a store another never
 * reads, which surfaces as "0 documents". Step 3 exists because an earlier
 * revision had bootstrap fall back to `template` while the read surfaces fell
 * back to qmd's global index, producing exactly that split.
 *
 * Keeping the pin as an override is what makes derivation safe to adopt: a
 * vault that wants a name surviving a folder rename — or wants to keep a store
 * it already built — pins the field and nothing derives.
 *
 * Null means "use qmd's default global index" and is reachable only when the
 * manifest is absent or carries neither field.
 */
export function resolveQmdIndex(
	manifestJson: string | null,
	vaultRoot: string,
): string | null {
	return (
		parseQmdIndex(manifestJson) ??
		deriveQmdIndex(vaultRoot) ??
		parseTemplateName(manifestJson)
	);
}

/**
 * Build the argv tail for a `qmd` CLI invocation, prepending `--index <name>`
 * when the vault has configured a named index. Callers pass the subcommand
 * and its args (e.g. `["update"]`, `["query", text, "--json"]`); the return
 * value is the full argv after the `qmd` command itself.
 */
export function qmdArgsWithIndex(
	index: string | null,
	subcommandArgs: readonly string[],
): string[] {
	return index === null
		? [...subcommandArgs]
		: ["--index", index, ...subcommandArgs];
}

/**
 * True when a captured stderr blob is @tobilu/qmd's native `better-sqlite3`
 * binding failing to load because it was compiled against a different Node
 * ABI than the one currently running (`ERR_DLOPEN_FAILED` / a
 * `NODE_MODULE_VERSION` mismatch message). This is a DISTINCT failure mode
 * from "store missing/empty" (see `qmdStoreLooksEmpty` in the hook script):
 * the sqlite file can be tens of MB and perfectly healthy, but every qmd
 * invocation still crashes before it ever opens it, because the native
 * addon itself won't load under the current Node binary — typically after
 * a Node upgrade on the host machine. Query results and the whole MCP
 * server go silently dark in this state (the fire-and-forget re-index spawn
 * swallows the crash), so this check exists to catch it instead of letting
 * a session quietly fall back to Grep/Read for the rest of its life.
 */
export function isQmdNativeAbiMismatch(stderr: string): boolean {
	return (
		stderr.includes("NODE_MODULE_VERSION") ||
		stderr.includes("ERR_DLOPEN_FAILED")
	);
}

/**
 * Derive the @tobilu/qmd package root (the directory containing its
 * package.json) from `resolveQmdEntry()`'s resolved entry path
 * (`.../@tobilu/qmd/dist/cli/qmd.js`), so a native-module rebuild can run
 * `npm rebuild` with that directory as its cwd — portable across a global
 * npm install, a local one, Homebrew's node_modules layout, or Windows,
 * without hardcoding any machine-specific prefix path. Returns null when
 * the entry itself is null (no resolvable install to rebuild) or doesn't
 * match the expected `dist/cli/qmd.js` shape.
 */
export function qmdPackageRootFromEntry(entry: string | null): string | null {
	if (entry === null) return null;
	const marker = join("dist", "cli", "qmd.js");
	if (!entry.endsWith(marker)) return null;
	const prefixLen = entry.length - marker.length - 1; // -1 drops the separator before "dist"
	return prefixLen > 0 ? entry.slice(0, prefixLen) : null;
}

/**
 * Extract the `qmd_min_version` string from a `vault-manifest.json` source.
 * Returns null when the manifest is absent, malformed, or the field is not
 * a string — the min-version check simply doesn't run then (the field is
 * opt-in, and qmd itself is optional).
 */
export function parseQmdMinVersion(manifestJson: string | null): string | null {
	if (manifestJson === null) return null;
	try {
		const parsed = JSON.parse(manifestJson) as unknown;
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			"qmd_min_version" in parsed
		) {
			const value = (parsed as Record<string, unknown>)["qmd_min_version"];
			if (typeof value === "string" && value.length > 0) return value;
		}
	} catch {
		/* malformed manifest → treat as missing */
	}
	return null;
}

/**
 * True if a directory-entry name has a `.md` extension. Compared case-
 * insensitively so files saved as `.MD` or `.Md` (legal on case-insensitive
 * filesystems like NTFS and APFS, and produced by editors that preserve
 * pasted casing) are still recognized as markdown.
 */
export function isMarkdownFilename(name: string): boolean {
	return name.toLowerCase().endsWith(".md");
}

/**
 * Extract the root-level entries from `vault-manifest.json`'s `infrastructure`
 * list — files like CLAUDE.md, README.*.md, Home.md that aren't user content
 * and therefore shouldn't be scanned for open tasks. Glob patterns with `/`
 * (e.g. `.claude/**`) are excluded because they target subdirectories.
 *
 * Returns the raw patterns; matching against filenames is the caller's job
 * via {@link isInfraFilename}.
 */
export function parseInfraRootFilenames(
	manifestJson: string | null,
): readonly string[] {
	if (manifestJson === null) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(manifestJson);
	} catch {
		return [];
	}
	if (parsed === null || typeof parsed !== "object") return [];
	const infra = (parsed as Record<string, unknown>)["infrastructure"];
	if (!Array.isArray(infra)) return [];
	return infra.filter(
		(e): e is string => typeof e === "string" && !e.includes("/"),
	);
}

/**
 * True if `filename` matches any of the given root-level infrastructure
 * patterns. Patterns are literal filenames (`CLAUDE.md`) or globs with `*`
 * wildcards (`README.*.md`). Other regex metacharacters are escaped so a
 * pattern like `foo.md` matches `foo.md`, not `fooXmd`.
 */
export function isInfraFilename(
	filename: string,
	patterns: readonly string[],
): boolean {
	for (const p of patterns) {
		if (!p.includes("*")) {
			if (filename === p) return true;
			continue;
		}
		const re = new RegExp(
			"^" +
				p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") +
				"$",
		);
		if (re.test(filename)) return true;
	}
	return false;
}

/**
 * Aggregate unchecked Markdown tasks (`- [ ] …`) across multiple files and
 * format them as one string grouped by source. Tasks are taken in input
 * order — the caller decides which sources matter most (e.g. work/active
 * before vault root) and what counts as a "file". Returns "(no open tasks)"
 * when nothing matches. Caps total tasks at `limit` so a single noisy file
 * can't drown the section; non-positive `limit` returns "(no open tasks)".
 *
 * Source paths are sanitised before they become group headers — newlines
 * and carriage returns in a filename (legal on POSIX, possible via shared
 * drives) would otherwise corrupt the line-based output format and let
 * downstream parsers mis-attribute tasks to the wrong source.
 *
 * Output shape:
 *
 *   work/active/project-x.md
 *   - [ ] task one
 *   - [ ] task two
 *
 *   2026-05-18.md
 *   - [ ] daily task
 */
export function collectOpenTasks(
	sources: readonly { readonly path: string; readonly content: string }[],
	limit: number,
): string {
	const groups: string[] = [];
	let collected = 0;
	for (const { path, content } of sources) {
		if (collected >= limit) break;
		const lines = content
			.split(/\r?\n/)
			.filter((line) => /^\s*- \[ \]/.test(line));
		if (lines.length === 0) continue;
		const taken = lines.slice(0, limit - collected);
		// Collapse any CR/LF run (POSIX-only filename oddity) to a literal
		// `\n` escape — bare \r alone would otherwise slip past a /\r?\n/
		// regex but still corrupt the line-based output on consumers that
		// treat \r as a line separator (older macOS, some viewers).
		const safePath = path.replace(/[\r\n]+/g, "\\n");
		groups.push(`${safePath}\n${taken.join("\n")}`);
		collected += taken.length;
	}
	return groups.length > 0 ? groups.join("\n\n") : "(no open tasks)";
}

/**
 * Format the "Brain Topics" section — one line per brain/ note with its
 * description from frontmatter, so Claude sees what topic notes exist
 * without loading their full content. Omits North Star (already loaded
 * in its own section) and Memories (an index that just points here).
 * Appends "(empty)" when the note has no filled bullets, so Claude
 * knows not to waste a read on a stub.
 */
export function formatBrainIndex(
	entries: readonly {
		readonly name: string;
		readonly description: string | null;
		readonly hasContent: boolean;
	}[],
): string {
	const lines = entries
		.filter((e) => e.name !== "North Star" && e.name !== "Memories")
		.map((e) => {
			const desc = e.description ?? "(no description)";
			const suffix = e.hasContent ? "" : " (empty)";
			return `- [[${e.name}]] — ${desc}${suffix}`;
		});
	return lines.length > 0 ? lines.join("\n") : "(none)";
}

/**
 * Resolve the machine-local sqlite store path for a named qmd index,
 * honoring XDG_CACHE_HOME exactly like @tobilu/qmd's own store.js (and the
 * MCP wrapper's resolveIndexSqlitePath in qmd-mcp.mjs — kept in sync by
 * behavior-locking tests on both, since .mjs exports can't be imported into
 * .ts under strip-types). Pure: env and home are injected for testability.
 */
export function resolveIndexStorePath(
	indexName: string,
	env: Record<string, string | undefined>,
	home: string,
): string {
	const base = env["XDG_CACHE_HOME"] ?? join(home, ".cache");
	return join(base, "qmd", `${indexName}.sqlite`);
}

/**
 * Eager-layer injection mode (#107): on `resume`/`compact` the static bulk
 * (North Star, brain index, file listing) is ALREADY in-conversation from
 * the session's first injection — re-injecting doubles cost for zero new
 * information. Full mode on `startup`/`clear` and on any missing/unknown
 * source (fail open — Codex/Gemini hosts don't send one).
 */
export function injectionMode(source: unknown): "full" | "pointer" {
	return source === "resume" || source === "compact" ? "pointer" : "full";
}
