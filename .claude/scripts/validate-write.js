#!/usr/bin/env node
/**
 * Post-write validation for vault notes.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function main() {
  let data = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => { data += chunk; });
  process.stdin.on('end', () => {
    try {
      const inputData = JSON.parse(data);

      const toolInput = inputData.tool_input;
      if (typeof toolInput !== 'object' || toolInput === null) {
        process.exit(0);
      }

      const filePath = toolInput.file_path;
      if (typeof filePath !== 'string' || !filePath) {
        process.exit(0);
      }

      // Only validate markdown files in the vault, skip dotfiles and templates
      if (!filePath.endsWith('.md')) {
        process.exit(0);
      }

      // Normalize path separators for cross-platform matching (Windows uses backslashes)
      const normalized = filePath.replace(/\\/g, '/');

      // Skip dotfiles, templates, thinking, and root template files (not vault notes)
      const basename = path.basename(normalized);
      const rootFiles = new Set([
        'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md',
        'CLAUDE.md', 'AGENTS.md', 'GEMINI.md',
      ]);
      if (rootFiles.has(basename)) {
        process.exit(0);
      }

      // Also skip translated READMEs (README.ja.md, README.zh-CN.md, etc.)
      if (basename.startsWith('README.') && basename.endsWith('.md')) {
        process.exit(0);
      }

      const skipPaths = ['.claude/', '.obsidian/', 'templates/', 'thinking/'];
      if (skipPaths.some((skip) => normalized.includes(skip))) {
        process.exit(0);
      }

      const warnings = [];

      const content = fs.readFileSync(filePath, 'utf-8');

      // Check for frontmatter
      if (!content.startsWith('---')) {
        warnings.push('Missing YAML frontmatter');
      } else {
        const parts = content.split('---', 3);
        if (parts.length >= 3) {
          const fm = parts[1];
          if (!fm.includes('tags:') && !fm.includes('tags :')) {
            warnings.push('Missing `tags` in frontmatter');
          }
          if (!fm.includes('description:') && !fm.includes('description :')) {
            warnings.push('Missing `description` in frontmatter (~150 chars required by vault convention)');
          }
          if (!fm.includes('date:') && !fm.includes('date :')) {
            warnings.push('Missing `date` in frontmatter');
          }
        }
      }

      // Check for wikilinks (skip very short notes)
      if (content.length > 300 && !content.includes('[[')) {
        warnings.push('No [[wikilinks]] found \u2014 every note must link to at least one other note (vault convention)');
      }

      if (warnings.length > 0) {
        const hintList = warnings.map((w) => `  - ${w}`).join('\n');
        const output = {
          hookSpecificOutput: {
            hookEventName: inputData.hook_event_name || 'PostToolUse',
            additionalContext: `Vault hygiene warnings for \`${basename}\`:\n${hintList}\nFix these before moving on.`,
          },
        };
        process.stdout.write(JSON.stringify(output));
      }
    } catch {
      // Silent exit — never block the user
    }
    process.exit(0);
  });
}

if (require.main === module) {
  try {
    main();
  } catch {
    process.exit(0);
  }
}
