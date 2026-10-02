import { describe, expect, test } from 'claude-code/testing'
import { carriesReport, parseStopReport, summaryLine, withLine, type StopReport } from './stop.ts'

// Run with `claude plugin test .claude/skills/obsidian-mind`. Each test's own
// `on` hooks sit beneath the mod and stand in for the engine and the vault.
// turn.complete is not a call a test can raise, so the line under the answer
// is checked through summaryLine and in a live session.

const ROOT = '/vault'
const report = (key: string, extra: Partial<StopReport> = {}): StopReport => ({
	key,
	claims: ['1 note(s) marked done but still in active/'],
	agentText: `Stop hook report, handed over with this message: ${key}`,
	...extra,
})

type World = { runs: string[]; passedDown: Array<Record<string, unknown>>; submitted: Array<{ text: string; context?: readonly string[] }>; dropNext: boolean }

/** The world beneath the mod. `reply` is what stop-checklist.ts prints, per call. */
function vault(on: Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1], reply: () => { exitCode: number; stdout: string }): World {
	const world: World = { runs: [], passedDown: [], submitted: [], dropNext: false }
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
		// A settings hook below can block a prompt: it never enters.
		if (world.dropNext) {
			world.dropNext = false
			return { drop: 'blocked by a hook below' }
		}
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

	test('each session sees its own first report, even with the same findings', async ($, on) => {
		// The shown identity carries the session id: the API does not say state
		// is reset when a new session begins, so the key does not rely on it.
		const world = vault(on, ok(report('shared')))
		await $.classic.Stop({ stop_hook_active: false, session_id: 's1' })
		await $.prompt.submit({ text: 'first' })
		await $.classic.Stop({ stop_hook_active: false, session_id: 's2' })
		await $.prompt.submit({ text: 'second' })

		expect(world.submitted[0]?.context).toEqual(['Stop hook report, handed over with this message: shared'])
		expect(world.submitted[1]?.context).toEqual(['Stop hook report, handed over with this message: shared'])
	})

	test('a prompt that is dropped below keeps the report for the next one', async ($, on) => {
		const world = vault(on, ok(report('kept')))
		await $.classic.Stop({ stop_hook_active: false })
		world.dropNext = true
		await $.prompt.submit({ text: 'blocked' })
		await $.prompt.submit({ text: 'entered' })

		expect(world.submitted[1]?.context).toEqual(['Stop hook report, handed over with this message: kept'])
	})

	test("a peer's message passes without the report; the person's next prompt gets it", async ($, on) => {
		const world = vault(on, ok(report('mine')))
		await $.classic.Stop({ stop_hook_active: false })
		await $.prompt.submit({ text: 'from a peer', origin: { kind: 'peer' } } as never)
		await $.prompt.submit({ text: 'typed' })

		expect(world.submitted[0]?.context ?? []).toEqual([])
		expect(world.submitted[1]?.context).toEqual(['Stop hook report, handed over with this message: mine'])
	})

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
		await $.prompt.submit({ text: 'next' })

		expect(world.runs.length).toBe(1)
		expect(world.passedDown[0]?.['om_mod']).toBe(undefined)
		expect(world.submitted[0]?.context ?? []).toEqual([])
	})
})

describe('parseStopReport', () => {
	test('reads a complete report', () => {
		const r = report('k', { urgent: 'push blocked' })
		expect(parseStopReport(JSON.stringify({ report: r }))).toEqual(r)
	})

	test('refuses a report missing a field or with a wrong type', () => {
		for (const bad of [{}, { report: {} }, { report: { ...report('k'), claims: 'x' } }, { report: { ...report('k'), claims: [1] } }, { report: { ...report('k'), urgent: 1 } }]) {
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

describe('withLine', () => {
	test('with nothing set below, the line is the text', () => {
		expect(withLine('the answer', 'the answer', 'vault check: x')).toBe('vault check: x')
	})

	test("a line another hook set below is kept, and ours follows it", () => {
		expect(withLine('TL;DR: done', 'the answer', 'vault check: x')).toBe('TL;DR: done\nvault check: x')
	})
})

describe('carriesReport', () => {
	test("the person's own prompts carry it: typed, over Remote Control, through the SDK", () => {
		for (const kind of ['composer', 'bridge', 'sdk'] as const) expect(carriesReport({ kind } as never)).toBe(true)
		expect(carriesReport(undefined)).toBe(true)
	})

	test("this mod's own prompt carries it; another plugin's does not", () => {
		expect(carriesReport({ kind: 'plugin', name: 'obsidian-mind' } as never)).toBe(true)
		expect(carriesReport({ kind: 'plugin', name: 'someone-else' } as never)).toBe(false)
	})

	test('a peer, a notification or a schedule never consumes it', () => {
		for (const kind of ['peer', 'peer-send-message', 'task-notification', 'scheduled-trigger', 'auto-continuation', 'unclassified'] as const) {
			expect(carriesReport({ kind } as never)).toBe(false)
		}
	})
})
