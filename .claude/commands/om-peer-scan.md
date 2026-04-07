# Peer PR Deep Scan

Deep scan a peer's GitHub PRs for performance review preparation. Produces a structured analysis saved to `perf/evidence/`.

## Usage

```
/peer-scan <name> <github-username> <repo> [period]
```

Example: `/peer-scan "Jane Doe" jdoe example-repo "Jan 2025 - Jun 2025"`

## Workflow

1. **Fetch full PR list** (limit 200):
   ```
   gh pr list --repo <org>/<repo> --author <username> --state all --limit 200 --json number,title,state,createdAt,mergedAt,additions,deletions
   ```

2. **Filter to review period** (default: last 6 months). For EACH PR in period, fetch details:
   ```
   gh pr view <number> --repo <org>/<repo> --json body,reviews,comments,additions,deletions,changedFiles,title,state,createdAt,mergedAt
   ```

3. **Produce structured analysis** with these sections:
   - **PR count by month** — table showing velocity trends
   - **Projects/themes** — group PRs by project area with descriptions of what was built
   - **Quality signals** — review comments, change requests, approval patterns, reverts, static analysis findings
   - **Notable contributions** — architectural decisions, complex fixes, test coverage, cross-team impact
   - **Growth signals** — scope expansion over time, leadership evidence
   - **Full PR table** — every PR with number, title, date, additions, deletions, state

4. **Save to vault** as `perf/evidence/<Name> PRs - <Period>.md` with frontmatter:
   ```yaml
   ---
   date: "<today>"
   description: "<one-line summary of findings>"
   person: "<Full Name>"
   cycle: "<e.g. h1-2026>"
   tags:
     - perf
     - evidence
   ---
   ```

## Important

- Be thorough — this feeds into performance reviews
- Note PRs that were reverted or closed (quality signal)
- Look for patterns in reviewer feedback (recurring issues = growth area)
- Identify cross-team PRs (collaboration evidence)
- Flag weekend/late-night work patterns if visible
- Map PRs to projects you have context on
