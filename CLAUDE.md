# Obsidian Mind (MCS Techpack)

An MCS techpack that configures Claude Code for Obsidian vault workflows — skills, session hooks, templates, and vault scaffolding.

## Pack Structure

| Directory | Purpose |
|-----------|---------|
| `hooks/` | SessionStart hook for vault file listing |
| `templates/` | CLAUDE.local.md sections injected by MCS |
| `scaffold/` | Vault template files created by configureProject |
| `scripts/` | Configuration scripts |

## Development

```bash
# Test locally
mcs pack add /path/to/obsidian-mind
cd ~/path/to/test-vault
mcs sync        # Select obsidian-mind
mcs doctor      # Verify

# Test removal
mcs sync        # Deselect obsidian-mind — artifacts should be cleaned up
```

## Skills Attribution

The Obsidian skills (obsidian-markdown, obsidian-cli, json-canvas, obsidian-bases, defuddle) are from [kepano/obsidian-skills](https://github.com/kepano/obsidian-skills) (MIT).
