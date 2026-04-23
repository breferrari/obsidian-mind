# Obsidian Mind

Dieser Vault ist für [Claude Code](https://claude.ai/code) erstellt und enthält ein vollständiges Betriebshandbuch in `CLAUDE.md`.

**Lesen Sie `CLAUDE.md` für alle Vault-Konventionen** – Struktur, Notiztypen, Verknüpfungsregeln, Frontmatter-Schemata, Indizes und Workflows. Der Großteil des Inhalts ist agentenunabhängig.

## Hooks

Die Hook-Skripte in `.claude/scripts/` sind agentenunabhängiges TypeScript und Shell, die nativ von Node über `--experimental-strip-types` ausgeführt werden – kein Build-Schritt, keine Laufzeitabhängigkeiten, kein Claude SDK. Hook-Konfigurationen werden für drei Agenten bereitgestellt:

| Agent | Konfiguration | Status |
|-------|--------|--------|
| Claude Code | `.claude/settings.json` | Volle Unterstützung |
| Codex CLI | `.codex/hooks.json` | Geteilte Hook-Skripte |
| Gemini CLI | `.gemini/settings.json` | Geteilte Hook-Skripte |

| Skript | Zweck | Claude-Ereignis | Codex-Ereignis | Gemini-Ereignis |
|--------|---------|--------------|-------------|--------------|
| `session-start.ts` | Vault-Kontext beim Start injizieren | SessionStart | SessionStart | SessionStart |
| `classify-message.ts` | Nachrichten klassifizieren, Routing-Hinweise injizieren | UserPromptSubmit | UserPromptSubmit | BeforeAgent |
| `validate-write.ts` | Frontmatter und Wikilinks validieren | PostToolUse | PostToolUse | AfterTool |
| `pre-compact.ts` | Transkript vor der Komprimierung sichern | PreCompact | — | PreCompress |

## Befehle

18 Befehle in `.claude/commands/` – agentenunabhängiges Markdown mit YAML-Frontmatter.

- **Claude Code / Gemini CLI**: aufrufen als `/om-standup`, `/om-dump`, etc.
- **Codex CLI**: Geben Sie den Befehlsnamen als regulären Prompt ohne das `/`-Präfix ein (z. B. `om-standup`). Codex wird die Befehlsdatei finden und ausführen.

## Gedächtnis

Das Gedächtnis des Vaults befindet sich in `brain/` – `Memories.md`, `Patterns.md`, `Key Decisions.md`, `Gotchas.md`. Dies sind einfache Markdown-Dateien, die jeder Agent lesen und schreiben kann. Wenn Sie etwas lernen, das es wert ist, sich daran zu erinnern, schreiben Sie es in die entsprechende `brain/`-Themennotiz mit einem Wikilink zum Kontext.

Der automatisch geladene Gedächtnisindex in `~/.claude/` ist spezifisch für Claude Code – überspringen Sie diesen Abschnitt in `CLAUDE.md`. Die `brain/`-Notizen auf der Vault-Seite sind die Quelle der Wahrheit.

## Subagenten

9 Subagenten in `.claude/agents/` erledigen isolierte Aufgaben (Brag-Spotting, Vault-Auditing, Cross-Linking usw.). Der Prompt-Inhalt ist agentenunabhängiges Markdown. Codex CLI (`.codex/agents/`) und Gemini CLI (`.gemini/agents/`) unterstützen dasselbe Muster – kopieren Sie die Dateien und passen Sie die YAML-Frontmatter-Felder an das Schema Ihres Agenten an.

## Was ist spezifisch für Claude Code

Nur der `~/.claude/` Auto-Memory-Loader ist wirklich spezifisch für Claude Code. Alles andere – Hooks, Befehle, Subagenten-Prompts, Vault-Gedächtnis – ist portabel.

## Einrichtung

**Codex CLI**: Liest `AGENTS.md` nativ. Für direkten Zugriff auf `CLAUDE.md`, fügen Sie Folgendes zu `~/.codex/config.toml` hinzu:
```toml
project_doc_fallback_filenames = ["CLAUDE.md"]
```

**Gemini CLI**: Liest `GEMINI.md` nativ. Für direkten Zugriff auf `CLAUDE.md`, fügen Sie Folgendes zu `~/.gemini/settings.json` hinzu:
```json
{ "context": { "fileName": ["GEMINI.md", "CLAUDE.md"] } }
```

**Andere Agenten** (Cursor, Windsurf, Copilot): Lesen Sie `AGENTS.md` für Vault-Konventionen. Die Hook-Unterstützung variiert je nach Agent.

Für weitere Informationen, siehe die [README](README.md).