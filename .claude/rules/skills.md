# Skills and Commands (Claude Code)

Claude-only: Claude Code loads this file beside `AGENTS.md` and the shared files in this folder, which hold every convention the other agents share.

## Skills & Capabilities

This vault has [obsidian-skills](https://github.com/kepano/obsidian-skills) installed in `.claude/skills/`. Follow these skill conventions:

- **obsidian-markdown**: Obsidian-flavored markdown -- wikilinks, embeds, callouts, properties. See `references/` for callout types, embed syntax, and property specs. Always prefer `[[wikilinks]]` over markdown links.
- **obsidian-cli**: CLI commands for vault operations when Obsidian is running. See `.claude/rules/obsidian-cli.md`.
- **json-canvas**: Create `.canvas` files with nodes, edges, and visual layouts. See `references/EXAMPLES.md`.
- **obsidian-bases**: Create `.base` files with views, filters, and formulas. Bases core plugin is enabled. See `references/FUNCTIONS_REFERENCE.md`.
- **defuddle**: Extract clean markdown from web pages via `defuddle parse <url> --md`.

### Custom Slash Commands

Defined in `.claude/commands/`. Claude Code auto-surfaces every command with its description in the session's skills list — **that injected list is the live catalog**. Do not maintain a command table here (it drifts; the injected list can't — see Write-Correctness law 6). **Agents without that injection (Codex, Gemini, Cursor): read `brain/Skills.md`** — it carries the full command catalog plus usage docs and workflow sequences.

## Where they live

| Folder | Purpose | Key Files |
|--------|---------|-----------|
| `.claude/commands/` | Slash commands (auto-surfaced in-session; catalog in `brain/Skills.md`) | One `.md` per command |
| `.claude/skills/` | Obsidian + QMD skills, and the `obsidian-mind` Claude Code mod | Skills load via the Skill tool; the mod loads as a plugin on Claude Code 2.1.287+ |

## Rule

- **Always invoke Obsidian skills via the Skill tool** before doing vault work. Load `obsidian-markdown` when creating/editing `.md` files. Load `obsidian-cli` when running vault commands. Load `obsidian-bases` or `json-canvas` when working with those file types.
