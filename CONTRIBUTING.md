# Contributing

Thanks for your interest in contributing to obsidian-mind!

## Quick Start

Issues and bug reports are welcome from anyone. Code contributions go through assignment:

1. Find or open an issue, and comment on it that you'd like to work on it
2. Wait for the maintainer to assign it to you (an issue is assigned when it fits the project's plans)
3. Fork the repo and create a branch from `main`
4. Make your changes. A code change comes with a test that fails on `main` and passes with it
5. Open a PR with a title following the [commit format](#pr-title-format), linking the issue
6. Once CI is green, the maintainer reviews it, then merges, requests changes, or closes it with context

A PR for an issue that isn't assigned to you is closed without review. Trivial typo fixes in documentation are the only exception.

## Before You Open a PR

**Every change starts with an assigned issue, small fixes included, unless it is a trivial typo fix in documentation.** For bigger changes, agree the approach on the issue before writing code. This includes:

- Rewrites, migrations, or language swaps
- New commands, agents, hooks, or vault structure
- Anything that touches the install story or runtime requirements
- Anything listed as self-owned in the [Roadmap](README.md#roadmap) section of the README

Some areas have ongoing work that isn't public yet, so the issue is where we check the direction against the roadmap. Saves you from building something that can't be merged.

## Picking up an issue

An issue's assignee is the one person whose PR for it gets reviewed.

| Label | What it means |
|---|---|
| `maintainer` | Work the maintainer is building or sequencing. Ask on the issue if you'd like to help with it. |
| `decision` | The deliverable is a ruling, not code. See [below](#some-issues-are-questions-and-they-close-differently). |

A few things that save everyone time:

- **Ask to be assigned, then wait.** Comment on the issue before you start. The assignment means two people don't build the same fix, and that the fix is wanted.
- **Build what the issue says.** Many issues here carry measurements, decisions and an explicit scope. If you think part of it is wrong, say so on the issue first; the issue gets updated before the code changes.
- **Move text as written, don't rewrite it.** When an issue says content moves between files (for example out of an instruction file), carry it over unchanged. Summarising or shortening it along the way drops rules that agents rely on, even when the result reads fine.
- **Tick only what you ran.** The PR checklist is read literally. If you couldn't run something, leave the box unticked and say why. That's fine, and far more useful than a tick.

## Some issues are questions, and they close differently

The tracker's default shape is "done when code lands". A few issues are not that shape: their deliverable is a **ruling**. *"Should `manifest-check` fail the build instead of only warning?"* is the type. No amount of implementation closes it, because what is missing is a decision.

Those carry the **`decision`** label. Without a route of their own they fail in two silent ways. They **idle as pseudo-tasks**, because every workflow assumption — open the issue, read scope and acceptance, execute — expects something buildable, so they get skipped past while looking like ordinary backlog. Or they get **answered implicitly**, when an implementation touching the same surface embeds an answer and nobody notices a decision was made. The second is worse: the ruling exists only as a side effect, and the losing branch's reasoning is never written down.

The route:

- **The deliverable is the ruling and its reasoning, written where the next reader will hit it** — the doc or section the issue names, not only the issue thread. A ruling filed only in the thread is not filed: the issue closes and the doc still reads as an omission.
- **Both branches get written.** "Declined" is a result. Record the case for the road not taken, because it will be raised again, and the second time nobody will remember why it lost.
- **Code is separate.** If the ruling is "build it", the build is a new issue that the ruling unblocks. A ruling must not wait behind an implementation.
- **A ruling that cannot be made yet is a finding, not a failure.** If it needs a measurement or usage data nobody has, say so on the issue and record what would settle it. That is a complete answer, not a deferral.

This is not a rule about when a decision earns a durable record. That gate lives in [AGENTS.md](AGENTS.md) under Decision Records and decides whether to write one at all. This is only about giving question-shaped issues a way through, so they stop masquerading as tasks.

## PR Title Format

**This is the most important convention.** PR titles become commit messages (squash merge) and feed the automated changelog. Use this format:

```
type: short description
```

**Write the description in the imperative mood**, as a command: what the change does when merged. "add", "fix", "make", "report", not "added", "adds", "fixing" or a noun phrase. A good test: the title should complete the sentence *"If merged, this PR will …"*.

| Prefix | When to use | Changelog |
|--------|-------------|-----------|
| `feat` | New command, agent, hook, or capability | Added |
| `fix` | Bug fix | Fixed |
| `docs` | Documentation only (README, translations, AGENTS.md) | Changed |
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
- `fix: stop classify-message crashing on empty input`
- `docs: update Japanese README with new commands`

**Bad examples:**
- `Feat/rename commands om prefix`: wrong format, casing
- `Update Skills.md`: missing type prefix
- `fix bug`: missing colon and description
- `fix: classify-message crash on empty input`: a noun phrase, not imperative
- `feat: added /om-review command`: past tense, not imperative

## Template Development Checklist

When adding or modifying commands, agents, hooks, or vault structure, **all of these files must stay in sync**:

| File | What to update |
|------|---------------|
| `AGENTS.md` | Vault structure table (no command table and no counts: Write-Correctness law 6) |
| `.claude/rules/subagents.md` | Agent table |
| `.claude/rules/hooks-per-agent.md`, `.claude/rules/hooks-and-mod.md` | Hook tables, when a hook or its event changes |
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
- [ ] The PR links an issue assigned to you (a trivial typo fix in documentation needs none)
- [ ] A code change comes with a test that fails on `main` and passes with it
- [ ] Counts match everywhere (commands, agents) if you added/removed any
- [ ] New command/agent appears in ALL doc tables (README + Skills.md, and `.claude/rules/subagents.md` for an agent)
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

Every other check confirms that a hook **ran**. The delivery gate confirms what **arrived**: it runs real Claude Code sessions in throwaway vaults and asks the model to quote the end of its session context and a marker from its middle, at startup, after `/compact`, after `/clear` and (with the mod) from a general-purpose subagent, with the `obsidian-mind` mod and with the settings hooks alone. Hook output past 10,000 characters once reached the model as a 2,000-character preview while every log said success (#254); this is the check that catches that class.

It needs a logged-in `claude` and costs model turns, so it runs by hand, not in CI. Before the README or `mod.yml` pins a Claude Code version:

1. Once: make an empty folder, open it in Claude Code and accept the trust prompt. The gate builds its vaults there, so the mod loads the way a user's does (a headless session cannot accept trust).
2. Run:

```bash
node --experimental-strip-types .github/scripts/delivery-gate.ts --trusted-dir <that folder> --self-test        # first: exits 0 when the gate can still fail
node --experimental-strip-types .github/scripts/delivery-gate.ts --trusted-dir <that folder> --file-issue       # then: every checkpoint PASS
```

For a change to the hook path alone (the settings hooks, not the mod), `--hooks-only` runs just the sessions without the mod; it cannot be combined with `--self-test`, which breaks the mod.

A self-test that does not exit 0 means the gate is broken: fix it before trusting a normal run. A normal run that fails files an issue with `--file-issue`, and that version is not recommended until it is resolved. What counts as PASS, FAIL and INVALID, the exit codes, and why each `/compact` and `/clear` changes the vault first are documented at the top of `.github/scripts/delivery-gate.ts`.

## Questions?

Open an issue or start a discussion. To contribute code, see [Quick Start](#quick-start).
