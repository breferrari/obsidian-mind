# Contributing

Thanks for your interest in contributing to obsidian-mind!

## Quick Start

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Open a PR with a title following the [commit format](#pr-title-format)
4. That's it — the maintainer will review and merge

## PR Title Format

**This is the most important convention.** PR titles become commit messages (squash merge) and feed the automated changelog. Use this format:

```
type: short description
```

| Prefix | When to use | Changelog section |
|--------|-------------|-------------------|
| `feat` | New command, agent, hook, or capability | Added |
| `fix` | Bug fix | Fixed |
| `docs` | Documentation only (README, translations, CLAUDE.md) | Changed |
| `refactor` | Code restructuring without behavior change | Changed |
| `test` | Adding or updating tests | Changed |
| `ci` | CI/CD workflow changes | Changed |
| `chore` | Maintenance, cleanup | Changed |
| `revert` | Reverting a previous change | Fixed |

**Examples:**
- `feat: add /om-review command`
- `fix: classify-message crash on empty input`
- `docs: update Japanese README with new commands`

**Bad examples:**
- `Feat/rename commands om prefix` — wrong format, casing
- `Update Skills.md` — missing type prefix
- `fix bug` — missing colon and description

## Template Development Checklist

When adding or modifying commands, agents, hooks, or vault structure, **all of these files must stay in sync**:

| File | What to update |
|------|---------------|
| `CLAUDE.md` | Command table, agent table, vault structure table, counts |
| `README.md` | Command table, agent table, vault structure diagram, counts |
| `README.ja.md`, `README.ko.md`, `README.zh-CN.md` | Same as README, in the respective language |
| `brain/Skills.md` | Command tables (by category), subagents table, workflows |
| `bases/*.base` | If new properties or note types are added |

## What NOT to Update

The release pipeline handles these automatically — **do not include in your PR**:

- `CHANGELOG.md` — auto-generated from commit messages on release
- `vault-manifest.json` version or released date — auto-bumped on release
- Version numbers in any file — the maintainer handles versioning

## Before Submitting

- [ ] PR title follows `type: description` format
- [ ] Counts match everywhere (commands, agents) if you added/removed any
- [ ] New command/agent appears in ALL doc tables (CLAUDE.md + README + Skills.md)
- [ ] All translations updated if you changed README.md
- [ ] Tests pass: `python .claude/scripts/test_hooks.py`
- [ ] Examples use generic dates and names, not specific to any company or person

## Running Tests

```bash
python .claude/scripts/test_hooks.py -v
```

Tests run automatically on PRs that touch `.claude/scripts/`.

## Questions?

Open an issue or start a discussion. PRs are welcome without prior assignment — just open it.
