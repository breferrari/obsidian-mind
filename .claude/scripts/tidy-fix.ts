#!/usr/bin/env node
/**
 * tidy-fix — the deterministic --fix consumer (#139).
 *
 * Re-runs the same pure detector libs the hooks use and ACTS on the two
 * finding classes that involve zero judgment; everything else is printed
 * as a refusal pointing at /om-tidy (agent tier). The refusal list is what
 * makes this safe to run from cron.
 *
 *   ACTS on:
 *     - completed-in-active  → git mv to work/archive/YYYY/ (year from the
 *       note's `date` frontmatter; current year when absent). A note inside
 *       an active/<Topic>/ cluster moves only when EVERY note in the
 *       cluster is completed — mixed clusters are judgment, refused.
 *     - misplaced-memory     → the #81 review sequence, verbatim: copy the
 *       stray file into brain/, regenerate the MEMORY.md index, VERIFY the
 *       copy byte-matches, and only then remove the stray.
 *
 *   REFUSES (by design, not omission):
 *     - topic clusters (token overlap is blind — shared context is agent
 *       judgment), oversized-note splits, open loops, inbox pressure,
 *       mixed-completion clusters, brain/ name collisions.
 *
 *   Never edits prose indexes (work/Index.md rows are reported, not moved
 *   — deterministic edits to judgment-shaped files is how fixers overreach).
 *
 * Dry-run by default; pass --apply to act. Idempotent: fixed findings stop
 * being findings, so a second run reports nothing.
 *
 * Under --apply, "Fixed:" lists only actions that succeeded. One that failed
 * is listed under "Failed:", its source left in place, and the process exits
 * 1 — cron output must never read as clean when something was not done.
 *
 * Usage:
 *   node --experimental-strip-types .claude/scripts/tidy-fix.ts [--apply]
 *
 * TIDY_FIX_MEMORY_DIR overrides the auto-memory dir (tests); otherwise it
 * is derived from Claude Code's project-folder naming (see `projectSlug`)
 * on every platform, and skipped when that folder doesn't exist.
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isMainModule } from "./lib/main-guard.ts";
import {
	extractFrontmatterField,
	isMarkdownFilename,
	parseInfraRootFilenames,
} from "./lib/session-start.ts";
import {
	parseMemoryRoot,
	parseOpenLoopConfig,
	scanActiveHygiene,
	walkMarkdown,
} from "./lib/active-hygiene.ts";
import { generateMemoryIndex } from "./lib/automemory-index.ts";
import { collectBrainNotes } from "./generate-memory-index.ts";
import { resolveProjectDir } from "./lib/project-dir.ts";

const ACTIVE_REL = "work/active";

type Report = {
	/** Dry-run: what would be done. Apply: what WAS done, verified. */
	readonly fixed: string[];
	/** Apply only: attempted and not done; the source is left in place. */
	readonly failed: string[];
	readonly refused: string[];
	readonly notes: string[];
};

/**
 * Record one deterministic fix. In dry-run the line is a plan; under
 * --apply it is an outcome, so it is filed by what `act` actually returned.
 */
function recordFix(
	report: Report,
	apply: boolean,
	line: string,
	act: () => boolean,
): void {
	if (!apply) report.fixed.push(line);
	else if (act()) report.fixed.push(line);
	else report.failed.push(line);
}

/**
 * Claude Code's project folder name: every character that is not a letter,
 * a digit or `-` becomes `-`, case kept, on every platform. Observed:
 * `C:\Dev\site.com-next` → `C--Dev-site-com-next`, a path with spaces →
 * dashes, `C:\` → `C--`, `/home/a/vault` → `-home-a-vault`. The same rule as
 * `.github/scripts/delivery-gate.ts:sessionDirs`.
 */
export function projectSlug(path: string): string {
	return path.replace(/[^A-Za-z0-9-]/g, "-");
}

/**
 * The auto-memory folder for this vault. Claude Code may slug the path as
 * given or as resolved (macOS's /var is /private/var), so both are tried and
 * the first that exists wins; neither existing means no memory here.
 */
function deriveMemoryDir(vaultRoot: string): string {
	const override = process.env["TIDY_FIX_MEMORY_DIR"];
	if (override) return override;
	const projects = join(
		process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude"),
		"projects",
	);
	let real = vaultRoot;
	try {
		real = realpathSync(vaultRoot);
	} catch {
		/* keep the path as given */
	}
	const dirs = [...new Set([vaultRoot, real].map(projectSlug))].map((slug) =>
		join(projects, slug, "memory"),
	);
	return dirs.find((d) => existsSync(d)) ?? (dirs[0] as string);
}

/** git mv with a plain-rename fallback (still zero-loss; noted in output). */
function moveTracked(
	vaultRoot: string,
	relSrc: string,
	relDest: string,
	notes: string[],
): boolean {
	try {
		mkdirSync(join(vaultRoot, dirname(relDest)), { recursive: true });
	} catch {
		notes.push(`  could not create ${dirname(relDest)}/ — ${relSrc} left in place`);
		return false;
	}
	const git = spawnSync("git", ["mv", relSrc, relDest], {
		cwd: vaultRoot,
		encoding: "utf-8",
	});
	if (git.status === 0) return true;
	try {
		renameSync(join(vaultRoot, relSrc), join(vaultRoot, relDest));
		notes.push(`  (plain rename for ${relSrc} — git mv unavailable here)`);
		return true;
	} catch {
		notes.push(`  could not move ${relSrc} — left in place`);
		return false;
	}
}

function archiveYear(vaultRoot: string, rel: string): string {
	try {
		const date = extractFrontmatterField(
			readFileSync(join(vaultRoot, rel), "utf-8"),
			"date",
		);
		const m = date?.match(/^(\d{4})/);
		if (m) return m[1] as string;
	} catch {
		/* fall through */
	}
	return String(new Date().getFullYear());
}

function fixCompletedInActive(
	vaultRoot: string,
	completed: readonly string[],
	apply: boolean,
	report: Report,
): void {
	// Group findings: loose files move alone; a file inside active/<Topic>/
	// moves only when the WHOLE cluster is completed.
	const completedSet = new Set(completed);
	const handledClusters = new Set<string>();

	for (const rel of completed) {
		const inside = rel.slice(`${ACTIVE_REL}/`.length);
		const slash = inside.indexOf("/");
		if (slash === -1) {
			const year = archiveYear(vaultRoot, rel);
			const dest = `work/archive/${year}/${inside}`;
			recordFix(report, apply, `${rel} → ${dest}`, () =>
				moveTracked(vaultRoot, rel, dest, report.notes),
			);
			report.notes.push(`  move its row in work/Index.md (${basename(rel)})`);
			continue;
		}
		const topic = inside.slice(0, slash);
		const clusterRel = `${ACTIVE_REL}/${topic}`;
		if (handledClusters.has(clusterRel)) continue;
		handledClusters.add(clusterRel);
		// Sorted: walkMarkdown returns filesystem order, which differs across
		// machines — output must be deterministic.
		const members = walkMarkdown(vaultRoot, clusterRel).sort();
		const allDone = members.every((m) => completedSet.has(m));
		if (!allDone) {
			report.refused.push(
				`${clusterRel}/ — mixed cluster (some notes still active); archiving a partial workstream is judgment`,
			);
			continue;
		}
		// The archive year is deterministic only when every member agrees;
		// a cluster spanning years has no correct single bucket — judgment.
		const years = new Set(members.map((m) => archiveYear(vaultRoot, m)));
		if (years.size > 1) {
			report.refused.push(
				`${clusterRel}/ — completed notes span years (${[...years].sort().join(", ")}); the archive-year choice is judgment`,
			);
			continue;
		}
		const year = [...years][0] as string;
		const dest = `work/archive/${year}/${topic}`;
		recordFix(report, apply, `${clusterRel}/ → ${dest}/ (whole cluster)`, () =>
			moveTracked(vaultRoot, clusterRel, dest, report.notes),
		);
		report.notes.push(`  move its row in work/Index.md (${topic})`);
	}
}

function fixMisplacedMemory(
	vaultRoot: string,
	apply: boolean,
	report: Report,
): void {
	const memDir = deriveMemoryDir(vaultRoot);
	let entries: string[];
	try {
		entries = readdirSync(memDir).filter(
			(n) => isMarkdownFilename(n) && n !== "MEMORY.md",
		);
	} catch {
		return; // no memory dir on this machine — nothing to fix
	}
	if (entries.length === 0) return;

	let migrated = 0;
	for (const stray of entries) {
		const target = join(vaultRoot, "brain", stray);
		if (existsSync(target)) {
			report.refused.push(
				`memory/${stray} — brain/${stray} already exists; merging content is judgment`,
			);
			continue;
		}
		report.notes.push(
			`  review brain/${stray} before committing — auto-memory content can be personal, and brain/ is repo-tracked`,
		);
		// Each stray is its own unit: one that cannot be read or written is
		// reported as failed, and the rest still migrate.
		recordFix(report, apply, `memory/${stray} → brain/${stray} (copy, verify, remove)`, () => {
			try {
				const content = readFileSync(join(memDir, stray), "utf-8");
				mkdirSync(join(vaultRoot, "brain"), { recursive: true });
				writeFileSync(target, content);
				if (readFileSync(target, "utf-8") !== content) {
					report.notes.push(
						`  VERIFY FAILED for ${stray} — stray left in place, copy left for inspection`,
					);
					return false;
				}
			} catch {
				report.notes.push(`  could not copy memory/${stray} — stray left in place`);
				return false;
			}
			migrated++;
			return true;
		});
	}
	if (apply && migrated > 0) {
		// Regenerate the index from brain/ (now including the migrated notes),
		// THEN remove the verified strays — hegu-1's sequence from #81.
		// Removal is GATED on successful regeneration: if the index step
		// fails, the strays stay (copies remain in brain/ for inspection).
		let indexOk = false;
		try {
			const notes = collectBrainNotes(vaultRoot);
			if (notes !== null) {
				writeFileSync(join(memDir, "MEMORY.md"), generateMemoryIndex(notes));
				report.notes.push("  MEMORY.md regenerated");
				indexOk = true;
			} else {
				report.notes.push(
					"  index NOT regenerated (brain/ unreadable) — strays left in place",
				);
			}
		} catch {
			report.notes.push(
				"  index regeneration failed — strays left in place",
			);
		}
		if (!indexOk) return;
		for (const stray of entries) {
			const target = join(vaultRoot, "brain", stray);
			if (!existsSync(target)) continue; // refused or verify-failed
			try {
				if (
					readFileSync(target, "utf-8") ===
					readFileSync(join(memDir, stray), "utf-8")
				) {
					rmSync(join(memDir, stray));
				}
			} catch {
				report.notes.push(
					`  could not remove memory/${stray} — copy in brain/ is verified; remove by hand`,
				);
			}
		}
	}
}

function main(): void {
	const apply = process.argv.includes("--apply");
	const vaultRoot = resolveProjectDir(process.cwd())
		.replaceAll("\\", "/")
		.replace(/\/+$/, "");

	let manifestJson: string | null = null;
	try {
		manifestJson = readFileSync(join(vaultRoot, "vault-manifest.json"), "utf-8");
	} catch {
		/* defaults */
	}
	const scan = scanActiveHygiene(
		vaultRoot,
		Date.now(),
		parseOpenLoopConfig(manifestJson),
		parseInfraRootFilenames(manifestJson),
		parseMemoryRoot(manifestJson),
	);

	const report: Report = { fixed: [], failed: [], refused: [], notes: [] };

	fixCompletedInActive(vaultRoot, scan.completedInActive, apply, report);
	fixMisplacedMemory(vaultRoot, apply, report);

	// Judgment tier — refuse loudly so cron output still surfaces the state.
	for (const c of scan.ungroupedClusters) {
		report.refused.push(
			`cluster "${c.token}" (${c.files.length} notes) — shared context is judgment`,
		);
	}
	for (const o of scan.oversizedNotes) {
		report.refused.push(`${o.path} (${o.sizeKb}KB) — splitting is judgment`);
	}
	for (const l of scan.openLoops) {
		report.refused.push(
			`${l.path} (${l.ageDays}d, ${l.openItems} open) — chase/close/park is the user's call`,
		);
	}
	if (scan.inboxPressure !== null) {
		report.refused.push(
			`${scan.inboxPressure.count} raw export(s) in work/meetings/ — run /om-intake`,
		);
	}

	const mode = apply ? "APPLIED" : "DRY-RUN (pass --apply to act)";
	console.log(`tidy-fix — ${mode}`);
	if (
		report.fixed.length === 0 &&
		report.failed.length === 0 &&
		report.refused.length === 0
	) {
		console.log("nothing to do — vault is clean.");
		return;
	}
	if (report.fixed.length > 0) {
		console.log(apply ? "\nFixed:" : "\nWould fix:");
		for (const f of report.fixed) console.log(`  ${f}`);
	}
	if (report.failed.length > 0) {
		console.log("\nFailed (left in place — see Notes):");
		for (const f of report.failed) console.log(`  ${f}`);
		process.exitCode = 1;
	}
	if (report.refused.length > 0) {
		console.log("\nRefused (judgment — run /om-tidy):");
		for (const r of report.refused) console.log(`  ${r}`);
	}
	if (report.notes.length > 0) {
		console.log("\nNotes:");
		for (const n of report.notes) console.log(`${n}`);
	}
}

if (isMainModule(import.meta.url)) main();
