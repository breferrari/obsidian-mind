import { describe, expect, test } from 'claude-code/testing'
import { CONTEXT_BLOCK, withSessionContext } from './context.ts'

// Run with `claude plugin test .claude/skills/obsidian-mind`. Each test's own
// `on` hooks sit beneath the mod and stand in for the engine and the vault.

const ROOT = '/vault'
const CONTEXT = '## Session Context\n\n### Date\n2026-10-03 (Saturday)\n\n_context injected: 0.1kB / 20.0kB budget_\n'

type Seen = { runs: Array<{ argv: readonly string[]; init?: { cwd?: string; env?: Record<string, string>; stdin?: string } }>; writes: Array<{ path: string; text: string }>; passedDown: Array<Record<string, unknown>> }

/** The world beneath the mod: the vault root, the script run, the file write and the settings hook. */
function vault(on: Parameters<Parameters<typeof test>[1] & ((...a: never[]) => unknown)>[1], script: { exitCode: number; stdout: string; stderr?: string }): Seen {
	const seen: Seen = { runs: [], writes: [], passedDown: [] }
	// A call on `$` is answered `{ value }` (or `{ deny }`).
	on('session.root', () => ({ value: ROOT }))
	on('process.run', (_$, e) => {
		seen.runs.push(e as Seen['runs'][number])
		return { value: { exitCode: script.exitCode, stdout: script.stdout, stderr: script.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
	})
	on('fs.write', (_$, e) => {
		seen.writes.push(e)
		return { value: undefined }
	})
	on('ui.invalidate', () => ({ value: undefined }))
	on('classic.SessionStart', (_$, e) => {
		seen.passedDown.push(e as unknown as Record<string, unknown>)
		return {}
	})
	return seen
}

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
	})

	test('when the script fails, the settings hook gets the original event and runs as without the mod', async ($, on) => {
		const seen = vault(on, { exitCode: 1, stdout: '', stderr: 'boom' })
		await $.classic.SessionStart({ source: 'startup' })

		// The mod ran and its script failed: not skipped for some other reason.
		expect(seen.runs.length).toBe(1)
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

	test('that block is replaced, not duplicated, on a re-render', () => {
		const once = withSessionContext({ blocks: [] }, PATH, 'old')
		const twice = withSessionContext(once, PATH, CONTEXT)
		expect(twice.blocks).toEqual([{ name: CONTEXT_BLOCK, text: CONTEXT }])
	})
})
