import { describe, expect, test } from 'claude-code/testing'
import { CONTEXT_BLOCK, withSessionContext } from './context.ts'
import { engine, ROOT, type On, type Reply } from './world.ts'

// Run with `claude plugin test .claude/skills/obsidian-mind`. Each test's own
// `on` hooks sit beneath the mod and stand in for the engine and the vault.

const CONTEXT = '## Session Context\n\n### Date\n2026-10-03 (Saturday)\n\n_context injected: 0.1kB / 20.0kB budget_\n'

/**
 * The world beneath the mod, plus every value the mod stores as this
 * session's context. The kit's `$` has no state noun to read it back, so the
 * writes are what a test can see; the last one is what prompt.context reads.
 */
function vault(on: On, script: Reply | (() => Reply), options: { hangFirstWrite?: boolean } = {}) {
	const context: unknown[] = []
	on('state.set', (_$, e, next) => {
		const write = e as { plugin?: string; key?: string; value?: unknown }
		if (write.plugin === 'obsidian-mind' && write.key === 'context') context.push(write.value)
		return next(e)
	})
	const world = engine(on, typeof script === 'function' ? script : () => script, options)
	return { ...world, passedDown: world.passedDown.SessionStart, context }
}
const lastContext = (seen: { context: unknown[] }) => seen.context.at(-1) ?? null

describe('session context (#265)', () => {
	test('runs the vault script in deliver mode, writes the context file, and stands the settings hook down', async ($, on) => {
		const seen = vault(on, { exitCode: 0, stdout: CONTEXT })
		await $.classic.SessionStart({ source: 'startup' })

		expect(seen.runs.length).toBe(1)
		expect(seen.runs[0]?.argv.at(-1)).toBe(`${ROOT}/.claude/scripts/session-start.ts`)
		expect(seen.runs[0]?.init?.cwd).toBe(ROOT)
		expect(seen.runs[0]?.init?.env?.['CLAUDE_PROJECT_DIR']).toBe(ROOT)
		expect(JSON.parse(seen.runs[0]?.init?.stdin ?? '{}')).toEqual(expect.objectContaining({ om_mod: 'deliver', source: 'startup' }))

		// The engine normalises the path per OS (`C:\vault\…` on Windows): check the file, not the spelling.
		expect(seen.writes.length).toBe(1)
		expect(seen.writes[0]?.path).toMatch(/vault[\\/]\.claude[\\/]session-context\.md$/)
		expect(seen.writes[0]?.text).toBe(CONTEXT)
		expect(seen.passedDown.length).toBe(1)
		expect(seen.passedDown[0]?.['om_mod']).toBe('standdown')

		// What prompt.context will add, and the re-render that makes it add it.
		expect(lastContext(seen)).toBe(CONTEXT)
		expect(seen.invalidated).toEqual(['prompt.context'])
	})

	test('a run that fails after one that worked clears the old context, so it cannot ride beside fresh hook output', async ($, on) => {
		let fail = false
		const seen = vault(on, () => (fail ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: CONTEXT }))

		await $.classic.SessionStart({ source: 'startup' })
		expect(lastContext(seen)).toBe(CONTEXT)
		fail = true
		await $.classic.SessionStart({ source: 'clear' })

		expect(seen.runs.length).toBe(2)
		expect(seen.passedDown[1]?.['om_mod']).toBe(undefined)
		expect(lastContext(seen)).toBe(null)
	})

	test('a context-file write that never settles does not hold up delivery', async ($, on) => {
		const world = vault(on, { exitCode: 0, stdout: CONTEXT }, { hangFirstWrite: true })
		await $.classic.SessionStart({ source: 'startup' })

		expect(world.writes.length).toBe(1)
		expect(world.passedDown[0]?.['om_mod']).toBe('standdown')
		expect(lastContext(world)).toBe(CONTEXT)
	})

	test('when the script fails, the settings hook gets the original event and runs as without the mod', async ($, on) => {
		const seen = vault(on, { exitCode: 1, stdout: '', stderr: 'boom' })
		await $.classic.SessionStart({ source: 'startup' })

		// The mod ran and its script failed: not skipped for some other reason.
		expect(seen.runs.length).toBe(1)
		expect(lastContext(seen)).toBe(null)
		expect(seen.passedDown.length).toBe(1)
		expect(seen.passedDown[0]?.['om_mod']).toBe(undefined)
		expect(seen.writes.length).toBe(0)
	})

	test('an empty context counts as a failure too: nothing is stood down for nothing', async ($, on) => {
		const seen = vault(on, { exitCode: 0, stdout: '  \n' })
		await $.classic.SessionStart({ source: 'clear' })

		expect(seen.runs.length).toBe(1)
		expect(seen.passedDown[0]?.['om_mod']).toBe(undefined)
	})
})

describe('withSessionContext', () => {
	const PATH = `${ROOT}/.claude/session-context.md`
	const claudeMd = { path: `${ROOT}/CLAUDE.md`, kind: 'project' as const, content: '# Vault' }

	test('adds the context as a project instruction file, after the files already there', () => {
		const out = withSessionContext({ blocks: [{ name: 'claudeMd', text: '' }], instructionFiles: [claudeMd] }, PATH, CONTEXT)
		expect(out.instructionFiles).toEqual([claudeMd, { path: PATH, kind: 'project', content: CONTEXT }])
		expect(out.blocks).toEqual([{ name: 'claudeMd', text: '' }])
	})

	test('replaces an earlier copy instead of adding a second', () => {
		const once = withSessionContext({ blocks: [], instructionFiles: [claudeMd] }, PATH, 'old')
		const twice = withSessionContext(once, PATH, CONTEXT)
		expect(twice.instructionFiles?.filter((file) => file.path === PATH)).toEqual([{ path: PATH, kind: 'project', content: CONTEXT }])
	})

	test('when the files behind claudeMd are unknown, the context rides as its own block', () => {
		const out = withSessionContext({ blocks: [{ name: 'claudeMd', text: 'rewritten' }] }, PATH, CONTEXT)
		expect(out.instructionFiles).toBe(undefined)
		expect(out.blocks).toEqual([{ name: 'claudeMd', text: 'rewritten' }, { name: CONTEXT_BLOCK, text: CONTEXT }])
	})

	test('a copy spelled with the other separator or drive case is still the same file', () => {
		const once = withSessionContext({ blocks: [], instructionFiles: [] }, 'C:\\vault/.claude/session-context.md', 'old')
		const respelled = { ...once, instructionFiles: once.instructionFiles?.map((f) => ({ ...f, path: 'c:\\vault\\.claude\\session-context.md' })) }
		const twice = withSessionContext(respelled, 'C:\\vault/.claude/session-context.md', CONTEXT)
		expect(twice.instructionFiles?.length).toBe(1)
		expect(twice.instructionFiles?.[0]?.content).toBe(CONTEXT)
	})

	test('that block is replaced, not duplicated, on a re-render', () => {
		const once = withSessionContext({ blocks: [] }, PATH, 'old')
		const twice = withSessionContext(once, PATH, CONTEXT)
		expect(twice.blocks).toEqual([{ name: CONTEXT_BLOCK, text: CONTEXT }])
	})
})
