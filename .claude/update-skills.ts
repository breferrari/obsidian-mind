#!/usr/bin/env node
/**
 * Update obsidian-skills from the kepano/obsidian-skills upstream.
 *
 * Run from vault root:
 *   node --experimental-strip-types .claude/update-skills.ts
 */

import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	rmSync,
	cpSync,
	existsSync,
	readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO = "kepano/obsidian-skills";
const SKILLS_DIR = ".claude/skills";

const tempDir = mkdtempSync(join(tmpdir(), "obsidian-skills-"));

try {
	console.log(`Fetching latest obsidian-skills from ${REPO}...`);
	const clone = spawnSync(
		"git",
		["clone", "--depth", "1", `https://github.com/${REPO}.git`, tempDir],
		{ stdio: "inherit" },
	);
	if (clone.status !== 0) {
		console.error(`git clone failed (exit ${clone.status})`);
		process.exit(1);
	}

	const sourceSkillsDir = join(tempDir, "skills");
	const sourceSkills = readdirSync(sourceSkillsDir, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name);

	for (const skillName of sourceSkills) {
		const src = join(sourceSkillsDir, skillName);
		const dest = join(SKILLS_DIR, skillName);
		const isUpdate = existsSync(dest);
		console.log(
			isUpdate
				? `Updating ${skillName}...`
				: `New skill found: ${skillName} — copying...`,
		);
		cpSync(src, dest, { recursive: true });
	}

	console.log("Done. Skills updated to latest.");
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}
