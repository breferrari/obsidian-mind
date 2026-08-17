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

## Some issues are questions, and they close differently

The tracker's default shape is "done when code lands". A few issues are not that shape: their deliverable is a **ruling**. *"Should `manifest-check` fail the build instead of only warning?"* is the type. No amount of implementation closes it, because what is missing is a decision.

Those carry the **`decision`** label. Without a route of their own they fail in two silent ways. They **idle as pseudo-tasks**, because every workflow assumption — open the issue, read scope and acceptance, execute — expects something buildable, so they get skipped past while looking like ordinary backlog. Or they get **answered implicitly**, when an implementation touching the same surface embeds an answer and nobody notices a decision was made. The second is worse: the ruling exists only as a side effect, and the losing branch's reasoning is never written down.

The route:

- **The deliverable is the ruling and its reasoning, written where the next reader will hit it** — the doc or section the issue names, not only the issue thread. A ruling filed only in the thread is not filed: the issue closes and the doc still reads as an omission.
- **Both branches get written.** "Declined" is a result. Record the case for the road not taken, because it will be raised again, and the second time nobody will remember why it lost.
- **Code is separate.** If the ruling is "build it", the build is a new issue that the ruling unblocks. A ruling must not wait behind an implementation.
- **A ruling that cannot be made yet is a finding, not a failure.** If it needs a measurement or usage data nobody has, say so on the issue and record what would settle it. That is a complete answer, not a deferral.

This is not a rule about when a decision earns a durable record. That gate lives in [CLAUDE.md](CLAUDE.md) under Decision Records and decides whether to write one at all. This is only about giving question-shaped issues a way through, so they stop masquerading as tasks.

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
- [ ] Any NEW guard, check, or config constraint has [demonstrated a red](#new-guards-must-demonstrate-a-red), recorded in the PR
- [ ] Examples use generic dates and names, not specific to any company or person

## Running Tests

```bash
cd .claude/scripts && npm test
```

Tests run automatically on PRs that touch `.claude/scripts/`.

### New guards must demonstrate a red

A guard that has never failed on a violation is indistinguishable from a guard that cannot fail, and this repo has shipped that class more than once: a bootstrap check that only looked for *absence*, so it stayed green for months while the thing it protected was broken (#100); a `tsconfig.json` `include` path that matched nothing after a move, so a file shipping to users fell out of the typecheck program while every check passed (#152); `manifest-check` warning and never failing, which is the exact gap `.mcp.json` slipped through (#48, #51). In each case the check existed, looked settled, and proved nothing.

So, for any **new** guard, hook validation, CI check, or config constraint:

> A check counts as landed only after it has failed once on a deliberate violation: break the thing it protects, watch it go red, revert, watch it pass. Record that red in the PR — one line, what was broken and what fired.

That is one demonstrated red at introduction time, which is cheap, and it converts "a check exists" into "a check works."

This is **not** a demand for permanent negative-fixture CI jobs on every guard — whether one is worth keeping stays a per-case call, and `hook-config.test.ts` shows the pattern where it is. It is also **not retroactive**: existing checks get the treatment opportunistically, when next touched.

## Questions?

Open an issue or start a discussion. For small changes, PRs are welcome directly. For anything bigger, see [Before You Open a PR](#before-you-open-a-pr).
