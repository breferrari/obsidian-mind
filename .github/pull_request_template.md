## Summary
<!-- What does this PR do? One or two sentences. -->

## Type
<!-- Your PR title must start with one of these prefixes. -->
<!-- e.g. "feat: add /om-review command" -->

- [ ] `feat` — new command, agent, hook, or capability
- [ ] `fix` — bug fix
- [ ] `docs` — documentation only
- [ ] `refactor` — code restructuring, no behavior change
- [ ] `test` — adding or updating tests
- [ ] `ci` — CI/CD workflow changes
- [ ] `chore` — maintenance, cleanup
- [ ] `build` — build system or packaging changes
- [ ] `perf` — performance improvements
- [ ] `style` — formatting, no behavior change
- [ ] `revert` — revert a previous change

## Checklist

- [ ] PR title follows `type: description` format
- [ ] Tests pass (`python .claude/scripts/test_hooks.py`)
- [ ] Doc tables updated if adding commands/agents (CLAUDE.md, README, Skills.md, translations)
- [ ] No changes to CHANGELOG.md or vault-manifest.json version (automated by release pipeline)
