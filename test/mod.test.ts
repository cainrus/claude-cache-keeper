/**
 * The mod's `/cache-keeper:ping` path end to end: hooks/gate.ts's turn.step
 * hands the turn to hooks/keepalive.ts `manualPing`, which runs the real CLI
 * (`ping-now`, then `forked`) against a temporary keeper home. Only the
 * engine is faked: `$.model.fork` answers what each test says.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { record } from '../src/commands.ts'
import { readLedger } from '../src/ledger.ts'
import { loadSession } from '../src/state.ts'
import { register } from '../hooks/gate.ts'
import { manualPing } from '../hooks/keepalive.ts'
import { configFor, makeCtx, MIN, SID, tempHome, writeTranscript } from './helpers.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TAG = '<command-message>cache-keeper:ping</command-message>\n<command-name>/cache-keeper:ping</command-name>'

/** The CLI's env: this test's home, none of the runner's own keeper settings. */
function cliEnv(home: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: '/nonexistent', CACHE_KEEPER_HOME: home, ...extra }
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('CACHE_KEEPER_') && !(k in env)) env[k] = v
  return env
}

type ForkReply = { isAnswered: boolean; usage?: Record<string, number>; reason?: string }

function fakeEngine(home: string, forkReply: ForkReply | (() => never), env: Record<string, string> = {}) {
  const calls: string[] = []
  const $ = {
    plugin: { root: ROOT },
    session: { id: async () => SID },
    process: {
      run: async (argv: string[], opts: { stdin: string }) => {
        calls.push(argv.at(-1)!)
        const r = spawnSync(argv[0], argv.slice(1), { input: opts.stdin, encoding: 'utf8', env: cliEnv(home, env) })
        return { exitCode: r.status ?? 1, stdout: r.stdout }
      },
    },
    model: {
      fork: async () => {
        calls.push('$.model.fork')
        return typeof forkReply === 'function' ? forkReply() : forkReply
      },
    },
    clock: { after: () => ({ cancel() {} }), now: async () => Date.now() },
    env: { get: async () => undefined },
    fs: { read: async () => { throw new Error('none') } },
    ui: { status: () => {} },
  }
  return { $, calls }
}

/** A session whose last turn ended `agoMin` minutes ago, as `record` leaves it. */
function session(agoMin = 5, env: Record<string, string> = {}) {
  const home = tempHome()
  const config = configFor(home, env)
  const at = Date.now() - agoMin * MIN
  const transcript = writeTranscript(home, [{ at, read: 90_000, write: 1_000 }])
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, at + 500))
  return { home, config, transcript }
}

const HIT = { isAnswered: true, usage: { input_tokens: 3, cache_read_input_tokens: 91_000, cache_creation_input_tokens: 0, output_tokens: 2 } }

test('manualPing: a fork answers the command and the ledger logs it as manual', async () => {
  const { home } = session()
  const { $, calls } = fakeEngine(home, HIT)
  const text = await manualPing($)
  assert.match(text!, /^cache-keeper: pinged\. Read 91,000 cached tokens, wrote 0; cached till \d\d:\d\d\.$/)
  assert.deepEqual(calls, ['ping-now', '$.model.fork', 'forked'])
  assert.deepEqual(readLedger(home).map((e) => e.event), ['manual-ping'])
  const s = loadSession(home, SID)!
  assert.equal(s.pendingPing, false)
  assert.equal(s.pingsSoFar, 0)
  assert.equal(s.lastPingHit, null)
})

test('manualPing: a refusal is answered without a fork', async () => {
  const { home } = session(61)
  const { $, calls } = fakeEngine(home, HIT)
  assert.match((await manualPing($))!, /no ping sent: the cache expired at/)
  assert.deepEqual(calls, ['ping-now'])
  assert.ok(loadSession(home, SID)!.gateTurnAt !== undefined, "the refusal's turn is the mod's")
})

test('manualPing: a failed fork lets the turn reach the model, and its Stop logs the ping as manual', async () => {
  const { home, config, transcript } = session()
  const { $ } = fakeEngine(home, { isAnswered: false, reason: 'api-error' })
  assert.equal(await manualPing($), undefined)
  const s = loadSession(home, SID)!
  assert.equal(s.pendingPing, true)
  assert.equal(s.pingTransport, 'turn')
  const at = Date.now()
  writeTranscript(home, [{ at, read: 90_000, write: 200 }])
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, at + 500))
  assert.deepEqual(readLedger(home).map((e) => e.event), ['fork-failed', 'manual-ping'])
  assert.equal(loadSession(home, SID)!.lastPingHit, null)
})

test('manualPing: with forks off, the command turn itself is the ping', async () => {
  const { home } = session(5, { CACHE_KEEPER_FORK: '0' })
  const { $, calls } = fakeEngine(home, HIT, { CACHE_KEEPER_FORK: '0' })
  assert.equal(await manualPing($), undefined)
  assert.deepEqual(calls, ['ping-now'])
  const s = loadSession(home, SID)!
  assert.equal(s.pendingPing, true)
  assert.equal(s.pingManual, true)
})

test('manualPing: a fork that went out is never followed by a model turn, even when the CLI cannot record it', async () => {
  const { home, config, transcript } = session()
  const { $ } = fakeEngine(home, HIT)
  const run = $.process.run
  $.process.run = async (argv, opts) => (argv.at(-1) === 'forked' ? { exitCode: 1, stdout: '' } : run(argv, opts))
  assert.equal(await manualPing($), 'cache-keeper: pinged, but keeper could not record it.')
  // The mod answered that turn, so its Stop is the mod's, even after the slowest fork (2 min here).
  assert.ok(loadSession(home, SID)!.gateTurnAt !== undefined)
  const stopAt = Date.now() + 2 * MIN
  writeTranscript(home, [{ at: stopAt - 500, read: 90_000, write: 0 }])
  const before = loadSession(home, SID)!.lastTurnEndAt
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, stopAt))
  const after = loadSession(home, SID)!
  assert.equal(after.gateTurnAt, undefined)
  assert.equal(after.lastTurnEndAt, before)
})

// --- the gate's turn.step -------------------------------------------------------------

type Handler = (...args: any[]) => any

function hooksOf(): Record<string, Handler> {
  const hooks: Record<string, Handler> = {}
  register(((event: string, ...rest: unknown[]) => {
    hooks[event] = rest.at(-1) as Handler
  }) as any)
  return hooks
}

async function runStep(hooks: Record<string, Handler>, $: unknown, text: string) {
  await hooks['turn.start']($, { turnId: 't1', text }, (e: unknown) => e)
  const yielded: unknown[] = []
  let modelCalled = false
  const next = async function* () {
    modelCalled = true
    yield { kind: 'text', index: 0, text: 'ok' }
    return { answer: 'ok' }
  }
  const gen = hooks['turn.step']($, { turnId: 't1', index: 0, agentId: undefined }, next)
  let r = await gen.next()
  while (!r.done) {
    yielded.push(r.value)
    r = await gen.next()
  }
  return { yielded, result: r.value, modelCalled }
}

test("gate: /cache-keeper:ping's turn is answered by the fork, no model request", async () => {
  const { home } = session()
  const { $ } = fakeEngine(home, HIT)
  const { yielded, result, modelCalled } = await runStep(hooksOf(), $, TAG)
  assert.equal(modelCalled, false)
  assert.match((yielded[0] as any).text, /^cache-keeper: pinged\./)
  assert.equal(result.stopReason, 'end_turn')
})

test('gate: a message that quotes the marker or the tag still reaches the model', async () => {
  const { home } = session()
  const { $, calls } = fakeEngine(home, HIT)
  for (const text of [`what does ${'[cache-keeper:ping]'} do?`, `see ${TAG}`]) {
    const { modelCalled } = await runStep(hooksOf(), $, text)
    assert.equal(modelCalled, true, text)
  }
  assert.ok(!calls.includes('ping-now'))
})

test('gate: AskUserQuestion holds the cache by fork while the person answers, and stops after', async () => {
  const { home } = session(5, { CACHE_KEEPER_FORK: '1' })
  const { $, calls } = fakeEngine(home, HIT, { CLAUDE_CODE_ENTRYPOINT: 'cli' })
  const timers: Array<{ ms: number; cancelled: boolean }> = []
  $.clock.after = ((ms: number) => {
    const t = { ms, cancelled: false }
    timers.push(t)
    return { cancel: () => void (t.cancelled = true) }
  }) as any
  let waitingWhileAsked: number | undefined
  const result = await hooksOf()['tool.call']($, { tool: 'AskUserQuestion', questions: [] }, async () => {
    // The question is on screen: the session waits, and a ping is due one delay on.
    waitingWhileAsked = loadSession(home, SID)!.waitingSince
    calls.push('answered')
    return { result: 'yes' }
  })
  assert.deepEqual(result, { result: 'yes' })
  assert.deepEqual(calls, ['wait-start', 'answered', 'wait-end'])
  assert.equal(typeof waitingWhileAsked, 'number')
  assert.equal(timers.length, 1)
  assert.ok(timers[0].ms >= 60_000, `timer at ${timers[0].ms} ms`)
  assert.equal(timers[0].cancelled, true, 'the answer stops the timer')
  assert.equal(loadSession(home, SID)!.waitingSince, undefined)
})
