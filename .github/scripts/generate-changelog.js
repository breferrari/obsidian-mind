#!/usr/bin/env node
/**
 * Generate a CHANGELOG.md entry from commits since the previous tag.
 *
 * Usage: node generate-changelog.js <version>
 *   e.g. node generate-changelog.js v3.8
 *
 * Outputs:
 *   - Prepends new section to CHANGELOG.md (or replaces if version exists)
 *   - Updates vault-manifest.json version and released date
 *   - Prints the generated section to stdout (for use as GitHub Release body)
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');

const PREFIX_MAP = {
  feat: 'Added',
  fix: 'Fixed',
  docs: 'Changed',
  ci: 'Changed',
  refactor: 'Changed',
  perf: 'Changed',
  test: 'Changed',
  chore: 'Changed',
  build: 'Changed',
  style: 'Changed',
  revert: 'Fixed',
};

const SKIP_PREFIXES = new Set(['release', 'ci', 'test']);

const SECTION_ORDER = ['Added', 'Changed', 'Fixed', 'Removed'];

function runGit(...args) {
  try {
    return execFileSync('git', args, { encoding: 'utf-8' }).trim();
  } catch (err) {
    process.stderr.write(`git ${args.join(' ')} failed: ${err.stderr || err.message}\n`);
    process.exit(1);
  }
}

function getPreviousTag() {
  const output = runGit('tag', '--sort=-version:refname');
  const tags = output.split('\n').map((t) => t.trim()).filter(Boolean);
  if (tags.length >= 2) {
    return tags[1];
  }
  return null;
}

function getCommits(sinceTag) {
  const rangeSpec = sinceTag ? `${sinceTag}..HEAD` : 'HEAD';
  const output = runGit('log', rangeSpec, '--pretty=format:%s', '--first-parent');
  return output.split('\n').map((l) => l.trim()).filter(Boolean);
}

function classifyCommit(message) {
  // Strip PR reference suffix like (#25)
  const clean = message.replace(/\s*\(#\d+\)\s*$/, '');

  // Try prefix match: "feat: description" or "feat(scope): description"
  const match = clean.match(/^(\w+)(?:\([^)]*\))?\s*:\s*(.+)$/);
  if (match) {
    const prefix = match[1].toLowerCase();
    const description = match[2].trim();
    if (SKIP_PREFIXES.has(prefix)) {
      return [null, null];
    }
    const category = PREFIX_MAP[prefix] || 'Changed';
    return [category, description];
  }

  // No prefix — capitalize first letter, put in Changed
  if (!clean) {
    return ['Changed', clean];
  }
  return ['Changed', clean[0].toUpperCase() + clean.slice(1)];
}

function generateSection(version, commits) {
  const today = new Date().toISOString().slice(0, 10);
  const grouped = {};

  for (const msg of commits) {
    const [category, description] = classifyCommit(msg);
    if (category === null) continue;
    if (!grouped[category]) grouped[category] = [];
    grouped[category].push(description);
  }

  const lines = [`## ${version} \u2014 ${today}`, ''];

  for (const section of SECTION_ORDER) {
    if (grouped[section]) {
      lines.push(`### ${section}`);
      for (const item of grouped[section]) {
        lines.push(`- ${item}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

function prependToChangelog(section, version) {
  let content = fs.readFileSync('CHANGELOG.md', 'utf-8');

  // Check if this version already exists (idempotent on re-runs)
  const versionPattern = new RegExp(`^## ${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \u2014 .*$`, 'm');
  const existingPattern = new RegExp(
    `^## ${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \u2014 .*?(?=\\n## [^\\n]|$)`,
    'ms'
  );

  let newContent;
  if (versionPattern.test(content)) {
    newContent = content.replace(existingPattern, section.trimEnd());
  } else {
    // Insert after the "# Changelog" header
    const header = '# Changelog';
    const idx = content.indexOf(header);
    if (idx === -1) {
      newContent = `${header}\n\n${section}\n${content}`;
    } else {
      let insertAt = idx + header.length;
      while (insertAt < content.length && (content[insertAt] === '\n' || content[insertAt] === '\r')) {
        insertAt++;
      }
      newContent = content.slice(0, insertAt) + '\n' + section + '\n' + content.slice(insertAt);
    }
  }

  fs.writeFileSync('CHANGELOG.md', newContent, 'utf-8');
}

function normalizeVersion(version) {
  const match = version.match(/^v?(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!match) {
    process.stderr.write(`Invalid version '${version}'. Expected vX.Y or vX.Y.Z.\n`);
    process.exit(1);
  }
  const [, major, minor, patch] = match;
  return `${major}.${minor}.${patch || '0'}`;
}

function updateManifest(version) {
  const manifest = JSON.parse(fs.readFileSync('vault-manifest.json', 'utf-8'));
  manifest.version = normalizeVersion(version);
  manifest.released = new Date().toISOString().slice(0, 10);
  fs.writeFileSync('vault-manifest.json', JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

function main() {
  if (process.argv.length < 3) {
    process.stderr.write('Usage: node generate-changelog.js <version>\n');
    process.exit(1);
  }

  const version = process.argv[2];
  const prevTag = getPreviousTag();
  const commits = getCommits(prevTag);

  if (commits.length === 0) {
    process.stderr.write('No commits found since previous tag.\n');
    process.exit(1);
  }

  const section = generateSection(version, commits);

  if (!commits.some((msg) => classifyCommit(msg)[0] !== null)) {
    process.stderr.write('All commits were skipped (ci/test/release only). Nothing to changelog.\n');
    process.exit(1);
  }

  prependToChangelog(section, version);
  updateManifest(version);

  // Print section for GitHub Release body
  console.log(section);
}

main();
