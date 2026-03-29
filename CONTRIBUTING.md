# Contributing

## Template Development Checklist

When adding or modifying commands, agents, hooks, or vault structure, **all of these files must stay in sync**:

| File | What to update |
|------|---------------|
| `CLAUDE.md` | Command table, agent table, vault structure table, counts (commands/agents), root files rule |
| `README.md` | Command table, agent table, vault structure diagram, counts, relevant sections |
| `brain/Skills.md` | Command tables (by category), subagents table, usage notes, workflows if affected |
| `CHANGELOG.md` | New version entry at top with Added/Changed/Fixed sections |
| `vault-manifest.json` | Version number, infrastructure globs, scaffold paths, frontmatter schemas, version fingerprints |
| `bases/*.base` | If new properties or note types are added, update relevant Base views |

## Before Creating a PR

- Counts match everywhere (commands, agents)
- New command/agent appears in ALL tables (CLAUDE.md + README + Skills.md)
- `vault-manifest.json` version is bumped
- CHANGELOG has the new version entry
- All infrastructure paths in the manifest actually exist (`ls` each non-glob path)
- Examples use generic dates and names, not specific to any company or person
