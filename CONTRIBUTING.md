# Contributing

Thanks for your interest in contributing to obsidian-mind!

## Quick Start

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Open a PR with a title following the [commit format](#pr-title-format)
4. The maintainer will review, then merge, request changes, or close with context

## Before You Open a PR

**Small changes can go straight to PR.** Typos, fixes, one-file updates, doc corrections. Just open it.

**Bigger changes should start with an issue.** This includes:

- Rewrites, migrations, or language swaps
- New commands, agents, hooks, or vault structure
- Anything that touches the install story or runtime requirements
- Anything listed as self-owned in the [Roadmap](README.md#roadmap) section of the README

Some areas have ongoing work that isn't public yet. Opening an issue first lets us check whether the direction is already on the roadmap before you write code. Saves you from building something that can't be merged.

## PR Title Format

**This is the most important convention.** PR titles become commit messages (squash merge) and feed the automated changelog. Use this format:

```
type: short description
```

| Prefix | When to use | Changelog |
|--------|-------------|-----------|
| `feat` | New command, agent, hook, or capability | Added |
| `fix` | Bug fix | Fixed |
| `docs` | Documentation only (README, translations, CLAUDE.md) | Changed |
| `refactor` | Code restructuring without behavior change | Changed |
| `chore` | Maintenance, cleanup | Changed |
| `build` | Build system or packaging changes | Changed |
| `perf` | Performance improvements | Changed |
| `style` | Formatting, no behavior change | Changed |
| `revert` | Reverting a previous change | Fixed |
| `ci` | CI/CD workflow changes | Skipped (internal) |
| `test` | Adding or updating tests | Skipped (internal) |

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
- [ ] Translations flagged if you changed README.md (maintainer can handle these)
- [ ] Tests pass: `cd .claude/scripts && npm test`
- [ ] Examples use generic dates and names, not specific to any company or person

## Running Tests

```bash
cd .claude/scripts && npm test
```

Tests run automatically on PRs that touch `.claude/scripts/`.

## Questions?

Open an issue or start a discussion. For small changes, PRs are welcome directly. For anything bigger, see [Before You Open a PR](#before-you-open-a-pr).
