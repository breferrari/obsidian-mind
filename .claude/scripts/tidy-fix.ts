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
 * Usage:
 *   node --experimental-strip-types .claude/scripts/tidy-fix.ts [--apply]
 *
 * TIDY_FIX_MEMORY_DIR overrides the auto-memory dir (tests); otherwise it
 * is derived from Claude Code's project-slug convention on POSIX paths and
 * skipped (with a note) when it can't be derived or doesn't exist.
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
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
	parseOpenLoopConfig,
	scanActiveHygiene,
	walkMarkdown,
} from "./lib/active-hygiene.ts";
import { generateMemoryIndex } from "./lib/memory-index.ts";
import { collectBrainNotes } from "./generate-memory-index.ts";

const ACTIVE_REL = "work/active";

type Report = {
	readonly fixed: string[];
	readonly refused: string[];
	readonly notes: string[];
};

/** Claude Code's project slug: POSIX path with separators dashed. */
function deriveMemoryDir(vaultRoot: string): string | null {
	const override = process.env["TIDY_FIX_MEMORY_DIR"];
	if (override) return override;
	const posix = vaultRoot.replaceAll("\\", "/").replace(/\/+$/, "");
	if (!posix.startsWith("/")) return null; // Windows slug convention unknown
	const slug = posix.replaceAll("/", "-");
	return join(homedir(), ".claude", "projects", slug, "memory");
}

/** git mv with a plain-rename fallback (still zero-loss; noted in output). */
function moveTracked(
	vaultRoot: string,
	relSrc: string,
	relDest: string,
	notes: string[],
): boolean {
	mkdirSync(join(vaultRoot, dirname(relDest)), { recursive: true });
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
			report.fixed.push(`${rel} → ${dest}`);
			if (apply) moveTracked(vaultRoot, rel, dest, report.notes);
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
		report.fixed.push(`${clusterRel}/ → ${dest}/ (whole cluster)`);
		if (apply) moveTracked(vaultRoot, clusterRel, dest, report.notes);
		report.notes.push(`  move its row in work/Index.md (${topic})`);
	}
}

function fixMisplacedMemory(
	vaultRoot: string,
	apply: boolean,
	report: Report,
): void {
	const memDir = deriveMemoryDir(vaultRoot);
	if (memDir === null) {
		report.notes.push(
			"memory dir not derivable on this platform — misplaced-memory scan skipped",
		);
		return;
	}
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
		report.fixed.push(`memory/${stray} → brain/${stray} (copy, verify, remove)`);
		report.notes.push(
			`  review brain/${stray} before committing — auto-memory content can be personal, and brain/ is repo-tracked`,
		);
		if (!apply) continue;
		const content = readFileSync(join(memDir, stray), "utf-8");
		mkdirSync(join(vaultRoot, "brain"), { recursive: true });
		writeFileSync(target, content);
		const copied = readFileSync(target, "utf-8");
		if (copied !== content) {
			report.notes.push(
				`  VERIFY FAILED for ${stray} — stray left in place, copy left for inspection`,
			);
			continue;
		}
		migrated++;
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
	const vaultRoot = (process.env["CLAUDE_PROJECT_DIR"] || process.cwd())
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
	);

	const report: Report = { fixed: [], refused: [], notes: [] };

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
	if (report.fixed.length === 0 && report.refused.length === 0) {
		console.log("nothing to do — vault is clean.");
		return;
	}
	if (report.fixed.length > 0) {
		console.log(apply ? "\nFixed:" : "\nWould fix:");
		for (const f of report.fixed) console.log(`  ${f}`);
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
