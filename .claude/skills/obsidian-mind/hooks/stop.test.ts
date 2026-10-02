import { describe, expect, test } from 'claude-code/testing'
import { carriesReport, fromPerson, parseStopReport, summaryLine, withLine, type StopReport } from './stop.ts'

// Run with `claude plugin test .claude/skills/obsidian-mind`. Each test's own
// `on` hooks sit beneath the mod and stand in for the engine and the vault.
// What the kit cannot establish is the order a live session raises them in
// (classic.Stop before turn.complete); that is checked in a live session.

const ROOT = '/vault'
const report = (key: string, extra: Partial<StopReport> = {}): StopReport => ({
	key,
	claims: ['1 note(s) marked done but still in active/'],
	agentText: `Stop hook report, handed over with this message: ${key}`,
	...extra,
})

type World = {
	runs: string[]
	passedDown: Array<Record<string, unknown>>
	submitted: Array<{ text: string; context?: readonly string[]; origin?: unknown }>
	/** The next prompt is dropped below, or the next one throws below. */
	dropNext: boolean
	throwNext: boolean
	/** A line another hook below sets under the answer, if any. */
	lowerLine: string | null
	/** Runs inside the next prompt's submit, before it enters or is dropped. */
	duringNext: (() => Promise<unknown>) | null
}

/** The world beneath the mod. `reply` is what stop-checklist.ts prints, per call. */
function vault(on: Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1], reply: () => { exitCode: number; stdout: string }): World {
	const world: World = { runs: [], passedDown: [], submitted: [], dropNext: false, throwNext: false, lowerLine: null, duringNext: null }
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
	on('prompt.submit', async (_$, e) => {
		world.submitted.push({ text: e.text, context: e.context, origin: e.origin })
		const during = world.duringNext
		world.duringNext = null
		if (during) await during()
		if (world.throwNext) {
			world.throwNext = false
			throw new Error('failed below')
		}
		// A settings hook below can block a prompt: it never enters.
		if (world.dropNext) {
			world.dropNext = false
			return { drop: 'blocked by a hook below' }
		}
		return { text: e.text, context: e.context }
	})
	on('turn.complete', (_$, e) => ({ text: world.lowerLine ?? e.answer }))
	on('fs.write', () => ({ value: undefined }))
	on('ui.invalidate', () => ({ value: undefined }))
	on('classic.SessionStart', () => ({}))
	return world
}

const ok = (r: StopReport) => () => ({ exitCode: 0, stdout: JSON.stringify({ report: r }) })

/** A main-loop answer that completed, as turn.complete receives it. */
const answered = (extra: Record<string, unknown> = {}) => ({ answer: 'the answer', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', ...extra }) as never

/** Let an unawaited submit and its follow-up settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const LINE = 'vault check: 1 note(s) marked done but still in active/ · the full report reaches the agent with the next message'
const HANDED = (key: string) => `Stop hook report, handed over with this message: ${key}`

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

describe('the line under the answer (#266)', () => {
	test('drawn once, under the next completed answer', async ($, on) => {
		vault(on, ok(report('k')))
		await $.classic.Stop({ stop_hook_active: false })

		expect((await $.turn.complete(answered())).text).toBe(LINE)
		expect((await $.turn.complete(answered())).text).toBe('the answer')
	})

	test('a subagent turn, an interrupt, an error or a refusal keeps it for the next answer', async ($, on) => {
		vault(on, ok(report('k')))
		await $.classic.Stop({ stop_hook_active: false })
		for (const turn of [answered({ agentId: 'a1' }), answered({ reason: 'aborted' }), answered({ reason: 'error' }), answered({ reason: 'refusal' })]) {
			expect((await $.turn.complete(turn)).text).toBe('the answer')
		}

		expect((await $.turn.complete(answered())).text).toBe(LINE)
	})

	test('a line a hook below set is kept, and ours follows it', async ($, on) => {
		const world = vault(on, ok(report('k')))
		world.lowerLine = 'TL;DR: done'
		await $.classic.Stop({ stop_hook_active: false })

		expect((await $.turn.complete(answered())).text).toBe(`TL;DR: done\n${LINE}`)
	})

	test('with no urgent finding, no prompt is submitted', async ($, on) => {
		const world = vault(on, ok(report('k')))
		await $.classic.Stop({ stop_hook_active: false })
		await $.turn.complete(answered())
		await settle()

		expect(world.submitted.length).toBe(0)
	})

	test('a report dropped by a resume is shown again when the same findings come back', async ($, on) => {
		const world = vault(on, ok(report('k')))
		await $.classic.Stop({ stop_hook_active: false, session_id: 'A' })
		await $.classic.SessionStart({ source: 'resume' } as never)
		await $.classic.SessionStart({ source: 'resume' } as never)
		await $.classic.Stop({ stop_hook_active: false, session_id: 'A' })
		await $.prompt.submit({ text: 'typed' })

		expect(world.submitted[0]?.context).toEqual([HANDED('k')])
	})

	test('a resume after the agent already had the report does not send it again', async ($, on) => {
		const world = vault(on, ok(report('k')))
		await $.classic.Stop({ stop_hook_active: false, session_id: 'A' })
		await $.prompt.submit({ text: 'first' })
		await $.classic.SessionStart({ source: 'resume' } as never)
		await $.classic.Stop({ stop_hook_active: false, session_id: 'A' })
		await $.prompt.submit({ text: 'second' })

		expect(world.submitted[0]?.context).toEqual([HANDED('k')])
		expect(world.submitted[1]?.context ?? []).toEqual([])
	})

	test('a compaction keeps the queued report, and what was shown stays shown', async ($, on) => {
		const world = vault(on, ok(report('k')))
		await $.classic.Stop({ stop_hook_active: false })
		await $.classic.SessionStart({ source: 'compact' } as never)
		await $.prompt.submit({ text: 'first' })
		await $.classic.Stop({ stop_hook_active: false })
		await $.prompt.submit({ text: 'second' })

		expect(world.submitted[0]?.context).toEqual([HANDED('k')])
		expect(world.submitted[1]?.context ?? []).toEqual([])
	})

	test('a compaction does not grant another urgent turn', async ($, on) => {
		let key = 'a'
		const world = vault(on, () => ({ exitCode: 0, stdout: JSON.stringify({ report: report(key, { urgent: `urgent ${key}` }) }) }))
		await $.classic.Stop({ stop_hook_active: false })
		await $.turn.complete(answered())
		await settle()
		await $.classic.SessionStart({ source: 'compact' } as never)
		key = 'b'
		await $.classic.Stop({ stop_hook_active: false })
		await $.turn.complete(answered())
		await settle()

		expect(world.submitted.map((p) => p.text)).toEqual(['urgent a'])
	})

	test('a compaction keeps what was queued', async ($, on) => {
		vault(on, ok(report('k')))
		await $.classic.Stop({ stop_hook_active: false })
		await $.classic.SessionStart({ source: 'compact' } as never)

		expect((await $.turn.complete(answered())).text).toBe(LINE)
	})

	for (const source of ['clear', 'resume', 'startup']) {
		test(`a ${source} in this process drops what the old conversation queued`, async ($, on) => {
			const world = vault(on, ok(report('k')))
			await $.classic.Stop({ stop_hook_active: false })
			await $.classic.SessionStart({ source } as never)

			expect((await $.turn.complete(answered())).text).toBe('the answer')
			await $.prompt.submit({ text: 'first in the new conversation' })
			expect(world.submitted.at(-1)?.context ?? []).toEqual([])
		})
	}

	test('once the person has the report, a line still waiting is dropped, not drawn late', async ($, on) => {
		vault(on, ok(report('k')))
		await $.classic.Stop({ stop_hook_active: false })
		await $.turn.complete(answered({ reason: 'refusal' }))
		await $.prompt.submit({ text: 'typed' })

		expect((await $.turn.complete(answered())).text).toBe('the answer')
	})

	test('a prompt dropped while a newer report was queued keeps the newer one', async ($, on) => {
		let key = 'old'
		const world = vault(on, () => ({ exitCode: 0, stdout: JSON.stringify({ report: report(key) }) }))
		await $.classic.Stop({ stop_hook_active: false })
		world.duringNext = async () => {
			key = 'new'
			await $.classic.Stop({ stop_hook_active: false })
		}
		world.dropNext = true
		await $.prompt.submit({ text: 'blocked' })
		await $.prompt.submit({ text: 'typed' })

		expect(world.submitted[1]?.context).toEqual([HANDED('new')])
	})
})

describe('an urgent finding (#266)', () => {
	const WITH_URGENT = (key: string, urgent: string) => `${HANDED(key)}\n\nUrgent: ${urgent}`

	test("gets one turn of its own, framed as the plugin's, carrying the report with the finding in it", async ($, on) => {
		const world = vault(on, ok(report('k', { urgent: 'push blocked' })))
		await $.classic.Stop({ stop_hook_active: false })
		await $.turn.complete(answered())
		await settle()

		expect(world.submitted.length).toBe(1)
		expect(world.submitted[0]?.text).toBe('push blocked')
		expect(world.submitted[0]?.origin).toEqual(expect.objectContaining({ kind: 'plugin', name: 'obsidian-mind' }))
		expect(world.submitted[0]?.context).toEqual([WITH_URGENT('k', 'push blocked')])
		await $.prompt.submit({ text: 'typed' })
		expect(world.submitted[1]?.context ?? []).toEqual([])
	})

	for (const [how, set] of [['dropped', (w: World) => (w.dropNext = true)], ['failing', (w: World) => (w.throwNext = true)]] as const) {
		test(`${how} below, its turn never starts and the next prompt carries the report with it`, async ($, on) => {
			const world = vault(on, ok(report('k', { urgent: 'push blocked' })))
			await $.classic.Stop({ stop_hook_active: false })
			set(world)
			await $.turn.complete(answered())
			await settle()
			await $.prompt.submit({ text: 'typed' })

			expect(world.submitted[1]?.context).toEqual([WITH_URGENT('k', 'push blocked')])
		})
	}

	test('one urgent turn per prompt the person sends: the next finding waits, and fires again once they speak', async ($, on) => {
		let key = 'a'
		const world = vault(on, () => ({ exitCode: 0, stdout: JSON.stringify({ report: report(key, { urgent: `urgent ${key}` }) }) }))
		await $.classic.Stop({ stop_hook_active: false })
		await $.turn.complete(answered())
		await settle()
		// The urgent turn ends with changed findings: no second turn of our own.
		key = 'b'
		await $.classic.Stop({ stop_hook_active: false })
		await $.turn.complete(answered())
		await settle()
		expect(world.submitted.map((p) => p.text)).toEqual(['urgent a'])

		// The person speaks and gets that report; their turn's new finding gets a turn again.
		await $.prompt.submit({ text: 'typed' })
		expect(world.submitted[1]?.context).toEqual([WITH_URGENT('b', 'urgent b')])
		key = 'c'
		await $.classic.Stop({ stop_hook_active: false })
		await $.turn.complete(answered())
		await settle()
		expect(world.submitted.map((p) => p.text)).toEqual(['urgent a', 'typed', 'urgent c'])
	})

	test('an urgent turn the person interrupts does not use up the next one', async ($, on) => {
		let key = 'a'
		const world = vault(on, () => ({ exitCode: 0, stdout: JSON.stringify({ report: report(key, { urgent: `urgent ${key}` }) }) }))
		await $.classic.Stop({ stop_hook_active: false })
		await $.turn.complete(answered())
		await settle()
		await $.turn.complete(answered({ reason: 'aborted' }))
		await $.prompt.submit({ text: 'typed' })
		key = 'b'
		await $.classic.Stop({ stop_hook_active: false })
		await $.turn.complete(answered())
		await settle()

		expect(world.submitted.map((p) => p.text)).toEqual(['urgent a', 'typed', 'urgent b'])
	})

	test('/clear gives the new conversation its own urgent turn', async ($, on) => {
		let key = 'a'
		const world = vault(on, () => ({ exitCode: 0, stdout: JSON.stringify({ report: report(key, { urgent: `urgent ${key}` }) }) }))
		await $.classic.Stop({ stop_hook_active: false })
		await $.turn.complete(answered())
		await settle()
		await $.classic.SessionStart({ source: 'clear' } as never)
		key = 'b'
		await $.classic.Stop({ stop_hook_active: false })
		await $.turn.complete(answered())
		await settle()

		expect(world.submitted.map((p) => p.text)).toEqual(['urgent a', 'urgent b'])
	})

	test('a newer report queued while a prompt was entering keeps its own line and urgent turn', async ($, on) => {
		let key = 'a'
		const world = vault(on, () => ({ exitCode: 0, stdout: JSON.stringify({ report: report(key, key === 'b' ? { urgent: 'urgent b' } : {}) }) }))
		await $.classic.Stop({ stop_hook_active: false })
		world.duringNext = async () => {
			key = 'b'
			await $.classic.Stop({ stop_hook_active: false })
		}
		await $.prompt.submit({ text: 'typed' })
		expect(world.submitted[0]?.context).toEqual([HANDED('a')])

		expect((await $.turn.complete(answered())).text).toBe(LINE)
		await settle()
		expect(world.submitted.map((p) => p.text)).toEqual(['typed', 'urgent b'])
	})

	test("a person's prompt dropped below does not renew the allowance: nothing of theirs reached the agent", async ($, on) => {
		let key = 'a'
		const world = vault(on, () => ({ exitCode: 0, stdout: JSON.stringify({ report: report(key, { urgent: `urgent ${key}` }) }) }))
		await $.classic.Stop({ stop_hook_active: false })
		await $.turn.complete(answered())
		await settle()
		world.dropNext = true
		await $.prompt.submit({ text: 'blocked' })
		key = 'b'
		await $.classic.Stop({ stop_hook_active: false })
		await $.turn.complete(answered())
		await settle()

		expect(world.submitted.map((p) => p.text)).toEqual(['urgent a', 'blocked'])
	})

	test("a peer's message does not count as the person speaking", async ($, on) => {
		let key = 'a'
		const world = vault(on, () => ({ exitCode: 0, stdout: JSON.stringify({ report: report(key, { urgent: `urgent ${key}` }) }) }))
		await $.classic.Stop({ stop_hook_active: false })
		await $.turn.complete(answered())
		await settle()
		await $.prompt.submit({ text: 'from a peer', origin: { kind: 'peer' } } as never)
		key = 'b'
		await $.classic.Stop({ stop_hook_active: false })
		await $.turn.complete(answered())
		await settle()

		expect(world.submitted.map((p) => p.text)).toEqual(['urgent a', 'from a peer'])
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
		expect(summaryLine(report('k', { claims: ['a', 'b'] }))).toBe('vault check: a · b · the full report reaches the agent with the next message')
	})

	test('with no findings it still points at the checklist', () => {
		expect(summaryLine(report('k', { claims: [] }))).toBe('vault check: wrap-up checklist · the full report reaches the agent with the next message')
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

	test("only the person's own prompts count as the person speaking, never a plugin's", () => {
		for (const kind of ['composer', 'bridge', 'sdk', 'slack-ping'] as const) expect(fromPerson({ kind } as never)).toBe(true)
		expect(fromPerson(undefined)).toBe(true)
		expect(fromPerson({ kind: 'plugin', name: 'obsidian-mind' } as never)).toBe(false)
		expect(fromPerson({ kind: 'peer' } as never)).toBe(false)
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
