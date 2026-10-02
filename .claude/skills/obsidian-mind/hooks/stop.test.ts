import { describe, expect, test } from 'claude-code/testing'
import { parseStopReport, summaryLine, type StopReport } from './stop.ts'

// Run with `claude plugin test .claude/skills/obsidian-mind`. Each test's own
// `on` hooks sit beneath the mod and stand in for the engine and the vault.
// turn.complete is not a call a test can raise, so the line under the answer
// is checked through summaryLine and in a live session.

const ROOT = '/vault'
const report = (key: string, extra: Partial<StopReport> = {}): StopReport => ({
	key,
	summary: 'Wrap-up checklist: archive completed work\nHygiene: 1 note(s) marked done but still in active/\nThe full report reaches the agent with your next message.',
	claims: ['1 note(s) marked done but still in active/'],
	agentText: `Stop hook report, handed over with this message: ${key}`,
	...extra,
})

type World = { runs: string[]; passedDown: Array<Record<string, unknown>>; submitted: Array<{ text: string; context?: readonly string[] }> }

/** The world beneath the mod. `reply` is what stop-checklist.ts prints, per call. */
function vault(on: Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1], reply: () => { exitCode: number; stdout: string }): World {
	const world: World = { runs: [], passedDown: [], submitted: [] }
	on('session.root', () => ({ value: ROOT }))
	on('process.run', (_$, e) => {
		world.runs.push(e.init?.stdin ?? '')
		const { exitCode, stdout } = reply()
		return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
	})
	on('classic.Stop', (_$, e) => {
		world.passedDown.push(e as unknown as Record<string, unknown>)
		return {}
	})
	on('prompt.submit', (_$, e) => {
		world.submitted.push({ text: e.text, context: e.context })
		return { text: e.text, context: e.context }
	})
	return world
}

const ok = (r: StopReport) => () => ({ exitCode: 0, stdout: JSON.stringify({ report: r }) })

describe('Stop report (#266)', () => {
	test('a changed report: the settings hook stands down and the next prompt carries the full report, once', async ($, on) => {
		const world = vault(on, ok(report('k1')))
		await $.classic.Stop({ stop_hook_active: false })

		expect(world.runs.length).toBe(1)
		expect(JSON.parse(world.runs[0] ?? '{}')).toEqual(expect.objectContaining({ om_mod: 'report' }))
		expect(world.passedDown[0]?.['om_mod']).toBe('standdown')

		await $.prompt.submit({ text: 'next' })
		expect(world.submitted[0]?.context).toEqual(['Stop hook report, handed over with this message: k1'])
		await $.prompt.submit({ text: 'after' })
		expect(world.submitted[1]?.context ?? []).toEqual([])
	})

	test('the same findings again: nothing is queued a second time', async ($, on) => {
		const world = vault(on, ok(report('same')))
		await $.classic.Stop({ stop_hook_active: false })
		await $.prompt.submit({ text: 'first' })
		await $.classic.Stop({ stop_hook_active: false })
		await $.prompt.submit({ text: 'second' })

		expect(world.runs.length).toBe(2)
		expect(world.submitted[0]?.context).toEqual(['Stop hook report, handed over with this message: same'])
		expect(world.submitted[1]?.context ?? []).toEqual([])
		expect(world.passedDown[1]?.['om_mod']).toBe('standdown')
	})

	test('changed findings are queued again', async ($, on) => {
		let key = 'a'
		const world = vault(on, () => ({ exitCode: 0, stdout: JSON.stringify({ report: report(key) }) }))
		await $.classic.Stop({ stop_hook_active: false })
		await $.prompt.submit({ text: 'first' })
		key = 'b'
		await $.classic.Stop({ stop_hook_active: false })
		await $.prompt.submit({ text: 'second' })

		expect(world.submitted[1]?.context).toEqual(['Stop hook report, handed over with this message: b'])
	})

	// "Each session sees its own first report" needs no test of the mod's: what
	// was shown lives in `$.state`, which the host keeps per session and resets
	// on `/clear`, the two ways a new session starts.

	test('a forced turn passes straight through: no run, no flag', async ($, on) => {
		const world = vault(on, ok(report('k')))
		await $.classic.Stop({ stop_hook_active: true })

		expect(world.runs.length).toBe(0)
		expect(world.passedDown[0]?.['om_mod']).toBe(undefined)
	})

	test('when the script fails, the settings hook gets the original event and nothing is queued', async ($, on) => {
		const world = vault(on, () => ({ exitCode: 1, stdout: '' }))
		await $.classic.Stop({ stop_hook_active: false })
		await $.prompt.submit({ text: 'next' })

		expect(world.runs.length).toBe(1)
		expect(world.passedDown[0]?.['om_mod']).toBe(undefined)
		expect(world.submitted[0]?.context ?? []).toEqual([])
	})

	test('an unusable report counts as a failure too', async ($, on) => {
		const world = vault(on, () => ({ exitCode: 0, stdout: '{"report":{"key":"k"}}' }))
		await $.classic.Stop({ stop_hook_active: false })

		expect(world.runs.length).toBe(1)
		expect(world.passedDown[0]?.['om_mod']).toBe(undefined)
	})
})

describe('parseStopReport', () => {
	test('reads a complete report', () => {
		const r = report('k', { urgent: 'push blocked' })
		expect(parseStopReport(JSON.stringify({ report: r }))).toEqual(r)
	})

	test('refuses a report missing a field or with a wrong type', () => {
		for (const bad of [{}, { report: {} }, { report: { ...report('k'), claims: 'x' } }, { report: { ...report('k'), urgent: 1 } }]) {
			expect(() => parseStopReport(JSON.stringify(bad))).toThrow()
		}
	})
})

describe('summaryLine', () => {
	test('names each finding in its own words and says where the rest went', () => {
		expect(summaryLine(report('k', { claims: ['a', 'b'] }))).toBe('vault check: a · b · the full report reaches the agent with your next message')
	})

	test('with no findings it still points at the checklist', () => {
		expect(summaryLine(report('k', { claims: [] }))).toBe('vault check: wrap-up checklist · the full report reaches the agent with your next message')
	})
})
