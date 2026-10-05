#!/usr/bin/env node
/**
 * CLI for markdown section character counting.
 *
 * Usage: node --experimental-strip-types charcount.ts <file> <section> [subsection] [limit]
 *
 * Examples:
 *   charcount.ts review.md "Project Name"                    → 847
 *   charcount.ts review.md "Project Name" "" 1000            → 847/1000 ✓
 *   charcount.ts review.md "Project Name" "" 500             → 847/500 ✗ (over by 347)
 *   charcount.ts review.md "Competency Name" "Current Level" 1000
 *
 * Exit codes: 0 within the limit (or no limit given), 1 over the limit or a
 * usage error, 2 when the section or sub-marker is not in the file. A missing
 * section is never reported as a count — `0/limit ✓` would pass a check that
 * never looked at anything.
 */

import { readFileSync, existsSync } from "node:fs";
import { countSection, formatResult } from "./lib/charcount.ts";

const [, , file, section, subArg, limitArg] = process.argv;

if (!file || !section) {
	process.stderr.write(
		'Usage: charcount.ts <file> "Section Header" [subsection] [limit]\n',
	);
	process.stderr.write('  subsection: use "" to skip when passing a limit\n');
	process.exit(1);
}

if (!existsSync(file)) {
	process.stderr.write(`File not found: ${file}\n`);
	process.exit(1);
}

const sub = subArg ? subArg : undefined;
const limit = limitArg ? Number(limitArg) : undefined;

if (limit !== undefined && (!Number.isFinite(limit) || limit < 0)) {
	process.stderr.write(`Invalid limit: ${limitArg}\n`);
	process.exit(1);
}

const content = readFileSync(file, { encoding: "utf-8" });
const count = countSection(content, sub ? { section, sub } : { section });
if (count === null) {
	process.stderr.write(
		sub
			? `Marker not found: "**${sub}:**" in section "${section}"\n`
			: `Section not found: "${section}" (looked for a ## or ### heading)\n`,
	);
	process.exit(2);
}
const result = formatResult(count, limit);
process.stdout.write(result.output + "\n");
process.exit(result.ok ? 0 : 1);
