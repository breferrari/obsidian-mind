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

### Before recommending a Claude Code release: the delivery gate

Every other check confirms that a hook **ran**. The delivery gate confirms what **arrived**: it runs real Claude Code sessions in a throwaway vault and asks the model to quote the last line of the session context it was given, at startup, after `/compact`, after `/clear` and from a general-purpose subagent, with the `obsidian-mind` mod and without it. Hook output past 10,000 characters once reached the model as a 2,000-character preview while every log said success (#254); this is the check that would have caught it.

It needs a logged-in `claude` and costs a few model turns, so it runs by hand, not in CI. Run it on any Claude Code version before the README or `mod.yml` pins it:

```bash
node --experimental-strip-types .github/scripts/delivery-gate.ts --self-test # first: exits 0 when the gate can still fail
node --experimental-strip-types .github/scripts/delivery-gate.ts             # then: PASS at every checkpoint
```

The self-test runs two broken copies of the mod, one that cuts its context everywhere and one that delivers it whole only at startup. Every checkpoint must fail against both, except the startup-only copy's own startup, which must pass: that control proves the copy delivered at all. Any other outcome means the gate is broken; fix it before trusting a normal run.

Each `/compact` and `/clear` first adds a note to the throwaway vault, so the context delivered after it ends with a size nobody has quoted yet: a compaction summary or an earlier answer cannot supply the new line, only a fresh delivery can.

Only the session's own events decide, and every other road an answer could take counts as INVALID, never PASS: a turn that used a tool, a `/compact` summary that itself carried the new size, a `/compact` or `/clear` that left no event of its own, a subagent that was not general-purpose, was handed the line, used tools or did not report its tool count, a settings hook that printed the context when the mod should have delivered it, and a session that errored, timed out or ran an extra turn. Exit codes: 0 pass; 1 a checkpoint did not receive the current context (cut, missing, or stale from before a shift, which means the mod did not deliver it again); 2 the run could not be judged. A FAIL wins over an INVALID elsewhere in the run. With `--self-test`: 0 the gate can fail, 1 the gate is broken (any checkpoint passed against a broken mod, or the control failed), 2 the run could not be judged.

The gate therefore requires the mod to deliver the context again on `/compact` and `/clear`, from the vault as it is then.

Two limits: the mod is loaded with `--plugin-dir` rather than found in the vault after the trust prompt, and the fixture's settings-hook context is too short to show a cut, so that path shows only that something arrived. The throwaway vaults run with qmd unresolvable, so they start no search bootstrap on your machine.

## Questions?

Open an issue or start a discussion. For small changes, PRs are welcome directly. For anything bigger, see [Before You Open a PR](#before-you-open-a-pr).
