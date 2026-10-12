Shared section: Claude Code and Grok load it at session start; other agents read it when AGENTS.md points here.

## Obsidian CLI

When Obsidian is running, prefer CLI over raw filesystem — it provides vault-aware search, backlink discovery, and property management. **On macOS, open Obsidian before invoking the CLI**: the first `obsidian` call launches the Electron app (visible window flash) if no instance is running; subsequent calls forward args silently. In non-interactive contexts where you can't guarantee Obsidian is open (background hooks, automation), prefer filesystem reads instead.

```bash
obsidian read file="Note Name"                    # Read a note
obsidian create name="Name" content="..." silent   # Create without opening
obsidian append file="Name" content="..."          # Append to note
obsidian search query="text" limit=10              # Vault-aware search
obsidian backlinks file="Name"                     # Discover connections
obsidian tags sort=count counts                    # List all tags
obsidian tasks daily todo                          # Open tasks
obsidian daily:read                                # Today's daily note
obsidian property:set name="status" value="done" file="Name"
obsidian orphans                                   # Unlinked notes
```

`file=` resolves like a wikilink (by name). `path=` for exact path from root. Use `silent` to prevent files from opening. Run `obsidian help` for full reference.
