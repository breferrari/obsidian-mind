import type { PromptContextResult } from 'claude-code'

/** The name the context renders under when no instruction file can carry it. */
export const CONTEXT_BLOCK = 'obsidian-mind'

/**
 * The first message's context with the session context added: as a project
 * instruction file, which Claude Code frames like CLAUDE.md, re-reads after
 * compaction and `/clear`, and gives general-purpose subagents.
 *
 * When a hook above rewrote the `claudeMd` text, the files behind it are
 * unknown and no file can be added (`instructionFiles` is undefined). The
 * context then rides as a block of its own, so the session still gets it:
 * the settings hook has already stood down for this event.
 *
 * Either way an earlier copy is replaced, never duplicated.
 */
export function withSessionContext(below: PromptContextResult, path: string, text: string): PromptContextResult {
	if (below.instructionFiles) {
		const others = below.instructionFiles.filter((file) => file.path !== path)
		return { ...below, instructionFiles: [...others, { path, kind: 'project', content: text }] }
	}
	const others = below.blocks.filter((block) => block.name !== CONTEXT_BLOCK)
	return { ...below, blocks: [...others, { name: CONTEXT_BLOCK, text }] }
}
