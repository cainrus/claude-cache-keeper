import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isPingCommand, isStatusCommand, PING_COMMAND, PING_MARKER, record, STATUS_COMMAND, touch, wake } from '../src/commands.ts'
import { FORK_PROMPT, forked, manualPingText, pingNow, type ForkAnswer, type ForkResult } from '../src/fork.ts'
import { configWarnings, settingsOf, statusReport } from '../src/inspect.ts'
import { measuredBreakeven, positionStats } from '../src/tune.ts'
import { readLedger } from '../src/ledger.ts'
import { formatReport, summarize } from '../src/report.ts'
import { loadAwayBudget, loadSession, saveAwayBudget, saveSession } from '../src/state.ts'
import { isPingTurn } from '../hooks/keepalive.ts'
import { assistantLine, configFor, makeCtx, MIN, SID, tempHome, writeTranscript, type TestCtx } from './helpers.ts'

const T0 = Date.parse('2026-01-01T10:00:00.000Z')
const BIG = { read: 90_000, write: 1_000 }

type OutCtx = TestCtx & { lines: string[] }

function ctxAt(config: ReturnType<typeof configFor>, now: number, env: Record<string, string> = {}): OutCtx {
  const ctx = makeCtx(config, now) as OutCtx
  ctx.lines = []
  ctx.stdout = (t) => ctx.lines.push(t)
  ctx.env = env
  return ctx
}

function setup(env: Record<string, string> = {}) {
  const home = tempHome()
  const config = configFor(home, env)
  const transcript = writeTranscript(home, [{ at: T0, ...BIG }])
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, T0 + 500))
  return { home, config, transcript }
}

function answerOf(fn: (input: any, ctx: any) => number, input: Record<string, unknown>, ctx: OutCtx): ForkAnswer {
  assert.equal(fn({ session_id: SID, ...input }, ctx), 0)
  assert.equal(ctx.lines.length, 1, 'one JSON line on stdout')
  return JSON.parse(ctx.lines[0])
}

const HIT: ForkResult = { isAnswered: true, usage: { input_tokens: 3, cache_read_input_tokens: 91_000, cache_creation_input_tokens: 300, output_tokens: 2 } }
const MISS: ForkResult = { isAnswered: true, usage: { input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 91_000, output_tokens: 2 } }

// --- matching ------------------------------------------------------------------

test('the commands are recognised by the typed line; ping also by its file body', () => {
  assert.ok(isStatusCommand(STATUS_COMMAND))
  assert.ok(isStatusCommand(`  ${STATUS_COMMAND} now `))
  assert.ok(!isStatusCommand(`${STATUS_COMMAND}x`))
  assert.ok(!isStatusCommand(`please run ${STATUS_COMMAND}`))
  assert.ok(isPingCommand(PING_COMMAND))
  assert.ok(isPingCommand(`${PING_MARKER} Prompt-cache keep-alive.`))
  assert.ok(!isPingCommand('/cache-keeper:pinged'))
})

test("the mod's copy of the ping matcher agrees with the CLI's", () => {
  for (const text of [PING_COMMAND, `${PING_COMMAND} now`, `x ${PING_MARKER} y`, '/cache-keeper:pinged', 'hello', `say ${PING_COMMAND}`]) {
    assert.equal(isPingTurn(text), isPingCommand(text), text)
  }
})

// --- /cache-keeper:status --------------------------------------------------------

test('status: blocked with a report, the idle stretch untouched', () => {
  const { home, config } = setup()
  const before = loadSession(home, SID)!
  const ctx = ctxAt(config, T0 + 10 * MIN)
  assert.equal(touch({ session_id: SID, prompt: STATUS_COMMAND }, ctx), 0)
  const out = JSON.parse(ctx.lines[0])
  assert.equal(out.decision, 'block')
  assert.match(out.reason, /nothing was sent to the model/)
  assert.match(out.reason, /cached till \d\d:\d\d/)
  assert.match(out.reason, /awaySec/)
  assert.deepEqual(loadSession(home, SID), before)
  assert.deepEqual(readLedger(home), [])
})

test('status before any turn says ready; after the TTL says expired', () => {
  const home = tempHome()
  const config = configFor(home)
  const ctx = ctxAt(config, T0)
  touch({ session_id: SID, prompt: STATUS_COMMAND }, ctx)
  assert.match(JSON.parse(ctx.lines[0]).reason, /ready: no turn has ended/)

  const s = setup()
  const late = ctxAt(s.config, T0 + 61 * MIN)
  touch({ session_id: SID, prompt: STATUS_COMMAND }, late)
  assert.match(JSON.parse(late.lines[0]).reason, /cache expired at/)
})

test('status: muted, a missed ping and a small context are named', () => {
  const { home, config } = setup()
  saveSession(home, { ...loadSession(home, SID)!, doneAt: T0 + MIN, lastPingHit: false, ctxTokens: 5_000 })
  const report = statusReport(loadSession(home, SID), config, {}, T0 + 2 * MIN)
  assert.match(report, /muted: by \/cache-keeper:done/)
  assert.match(report, /last ping: miss/)
  assert.match(report, /under minCtxTokens/)
})

test('settings: each value says whether env, config.json, the tuner or the default set it', () => {
  const home = tempHome()
  writeFileSync(join(home, 'config.json'), JSON.stringify({ awaySec: 7200, presenceSec: -1, handoff: { enabled: true }, statusLine: false }))
  writeFileSync(join(home, 'tuning.json'), JSON.stringify({ maxPings: 6, computedAt: T0 }))
  const env = { CACHE_KEEPER_MIN_AGE_SEC: '2900', CACHE_KEEPER_FORK: 'nope' }
  const config = configFor(home, env)
  const by = Object.fromEntries(settingsOf(config, env).map((r) => [r.key, r]))
  assert.deepEqual(by.awaySec, { key: 'awaySec', value: '7200', source: 'config.json' })
  assert.deepEqual(by.minAgeSec, { key: 'minAgeSec', value: '2900', source: 'env' })
  // A value the loader ignores is not a source.
  assert.equal(by.presenceSec.source, 'default')
  assert.equal(by.forkPings.source, 'default')
  assert.deepEqual(by.maxPings, { key: 'maxPings', value: '6', source: 'tuned' })
  assert.equal(by['handoff.enabled'].source, 'config.json')
  assert.deepEqual(by.statusLine, { key: 'statusLine', value: 'false', source: 'config.json' })
  assert.equal(by.skipIf.value, '-')
})

test('settings: a set maxPings is not tuned, and long commands are cut', () => {
  const home = tempHome()
  writeFileSync(join(home, 'config.json'), JSON.stringify({ maxPings: 2, skipIf: `echo ${'x'.repeat(100)}` }))
  const config = configFor(home)
  const by = Object.fromEntries(settingsOf(config, {}).map((r) => [r.key, r]))
  assert.deepEqual(by.maxPings, { key: 'maxPings', value: '2', source: 'config.json' })
  assert.equal(by.skipIf.value.length, 60)
  assert.ok(by.skipIf.value.endsWith('…'))
})

test('settings: every value is the one loadConfig resolved', () => {
  const home = tempHome()
  writeFileSync(join(home, 'config.json'), JSON.stringify({ awaySec: 900, hitRatio: 0.8, forkPings: false, handoff: { minCtxTokens: 50_000 } }))
  const env = { CACHE_KEEPER_PRESENCE_SEC: '200', CACHE_KEEPER_HIT_RATIO: '2', CACHE_KEEPER_DELAY_SEC: '2800', CACHE_KEEPER_HANDOFF: 'on' }
  const config = configFor(home, env)
  const by = Object.fromEntries(settingsOf(config, env).map((r) => [r.key, r]))
  assert.equal(by.awaySec.value, String(config.thresholds.awaySec))
  assert.equal(by.presenceSec.value, String(config.thresholds.presenceSec))
  // An env value the loader rejects (a ratio over 1) leaves the file's in force, and says so.
  assert.deepEqual(by.hitRatio, { key: 'hitRatio', value: String(config.hitRatio), source: 'config.json' })
  assert.deepEqual(by.delaySec, { key: 'delaySec', value: String(config.delaySec), source: 'env' })
  assert.deepEqual(by.forkPings, { key: 'forkPings', value: String(config.forkPings), source: 'config.json' })
  assert.deepEqual(by['handoff.enabled'], { key: 'handoff.enabled', value: 'true', source: 'env' })
  assert.deepEqual(by['handoff.minCtxTokens'], { key: 'handoff.minCtxTokens', value: '50000', source: 'config.json' })
})

test('a stale manual flag never turns the next automatic wake into a manual ping', () => {
  const { home, config, transcript } = setup()
  answerOf(pingNow, {}, ctxAt(config, T0 + 10 * MIN))
  // A real prompt overtakes the ping before its fork came back.
  touch({ session_id: SID, prompt: 'hello' }, ctxAt(config, T0 + 11 * MIN))
  const s = loadSession(home, SID)!
  assert.equal(s.pendingPing, false)
  assert.equal(s.pingManual, undefined)
  // ... and a late `forked` finds nothing open.
  assert.deepEqual(answerOf(forked, { fork: HIT }, ctxAt(config, T0 + 11 * MIN)), { action: 'none' })
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, T0 + 12 * MIN))
  assert.deepEqual(readLedger(home).filter((e) => e.event === 'manual-ping'), [])
})

// --- /cache-keeper:ping ----------------------------------------------------------

test('ping: the prompt hook lets it through and changes nothing', () => {
  const { home, config } = setup()
  const before = loadSession(home, SID)!
  const ctx = ctxAt(config, T0 + 10 * MIN)
  assert.equal(touch({ session_id: SID, prompt: PING_COMMAND }, ctx), 0)
  assert.deepEqual(ctx.lines, [])
  assert.deepEqual(loadSession(home, SID), before)
})

test('ping-now: a fork goes out, outside the automatic budget', () => {
  const { home, config } = setup()
  const a = answerOf(pingNow, {}, ctxAt(config, T0 + 10 * MIN))
  assert.deepEqual(a, { action: 'fork', prompt: FORK_PROMPT })
  const s = loadSession(home, SID)!
  assert.equal(s.pendingPing, true)
  assert.equal(s.pingTransport, 'fork')
  assert.equal(s.lastPingAt, T0 + 10 * MIN)
  assert.equal(s.pingManual, true)
  assert.equal(s.pingsSoFar, 0)
  // Logged once the fork comes back, never as one of keeper's own pings.
  assert.deepEqual(readLedger(home), [])
})

test('ping-now refuses what would ping into nothing', () => {
  const empty = tempHome()
  const none = answerOf(pingNow, {}, ctxAt(configFor(empty), T0))
  assert.equal(none.action, 'none')
  assert.match((none as any).text, /no turn has ended/)

  const cold = setup()
  assert.match((answerOf(pingNow, {}, ctxAt(cold.config, T0 + 61 * MIN)) as any).text, /expired at/)

  const compactedS = setup()
  saveSession(compactedS.home, { ...loadSession(compactedS.home, SID)!, compactedAt: T0 + MIN })
  assert.match((answerOf(pingNow, {}, ctxAt(compactedS.config, T0 + 2 * MIN)) as any).text, /compacted/)

  const busy = setup()
  answerOf(pingNow, {}, ctxAt(busy.config, T0 + 2 * MIN))
  assert.match((answerOf(pingNow, {}, ctxAt(busy.config, T0 + 3 * MIN)) as any).text, /already on its way/)

  const off = setup({ CACHE_KEEPER_DISABLED: '1' })
  assert.match((answerOf(pingNow, {}, ctxAt(off.config, T0 + 2 * MIN)) as any).text, /keeper is off/)
})

test('ping-now with forks off passes the turn to the model, as an open manual ping', () => {
  const { home, config } = setup({ CACHE_KEEPER_FORK: '0' })
  assert.deepEqual(answerOf(pingNow, {}, ctxAt(config, T0 + 50 * MIN)), { action: 'pass' })
  const s = loadSession(home, SID)!
  assert.equal(s.pendingPing, true)
  assert.equal(s.pingTransport, 'turn')
  assert.equal(s.pingManual, true)
  // The Stop sleeper, due a minute later, sends nothing on top of it.
  assert.equal(wake({ session_id: SID }, makeCtx(config, T0 + 51 * MIN, 0)), 0)
})

test('manual pings stay out of the budgets and the tuner', () => {
  const { home, config } = setup()
  saveAwayBudget(home, { awayPingsSincePresence: 2 })
  answerOf(pingNow, {}, ctxAt(config, T0 + 10 * MIN))
  const a = answerOf(forked, { fork: HIT }, ctxAt(config, T0 + 10 * MIN))
  assert.equal((a as any).dueInSec, config.delaySec)
  assert.equal(loadSession(home, SID)!.pingsSoFar, 0)
  assert.equal(loadAwayBudget(home).awayPingsSincePresence, 2)
  const entries = readLedger(home)
  assert.equal(measuredBreakeven(entries), measuredBreakeven([]))
  assert.deepEqual(positionStats(entries, config.cacheTtlSec), positionStats([], config.cacheTtlSec))
})

test('the reply names the deadline: now plus the TTL, local time', () => {
  const at = new Date(2026, 0, 1, 10, 7).getTime()
  assert.equal(manualPingText({ cacheRead: 5, cacheWrite: 1 }, at + 3600_000), 'cache-keeper: pinged. Read 5 cached tokens, wrote 1; cached till 11:07.')
  assert.match(manualPingText({ cacheRead: 0, cacheWrite: 9 }, at), /nothing was read from the cache: it had gone cold\. 9 tokens written, cached till 10:07\./)
})

test('status through the gate: blocked, and its Stop is the gate\'s', () => {
  const { home, config, transcript } = setup()
  const ctx = ctxAt(config, T0 + 10 * MIN)
  assert.equal(touch({ session_id: SID, prompt: STATUS_COMMAND, gate_turn: true }, ctx, true), 0)
  assert.equal(JSON.parse(ctx.lines[0]).decision, 'block')
  assert.equal(loadSession(home, SID)!.gateTurnAt, T0 + 10 * MIN)
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, T0 + 10 * MIN + 1000))
  assert.equal(loadSession(home, SID)!.lastTurnEndAt, T0)
})

test('status warns about settings that leave keeper unable to ping', () => {
  const home = tempHome()
  assert.deepEqual(configWarnings(configFor(home)), [])
  assert.match(configWarnings(configFor(home, { CACHE_KEEPER_MIN_AGE_SEC: '3600' }))[0], /no ping is ever due/)
  assert.match(configWarnings(configFor(home, { CACHE_KEEPER_DELAY_SEC: '600' }))[0], /the Stop sleeper never pings/)
  const ctx = ctxAt(configFor(home, { CACHE_KEEPER_DELAY_SEC: '600' }), T0)
  touch({ session_id: SID, prompt: STATUS_COMMAND }, ctx)
  assert.match(JSON.parse(ctx.lines[0]).reason, /warning: delaySec/)
})

test('a refused ping\'s turn is the mod\'s: its Stop changes nothing', () => {
  const { home, config, transcript } = setup()
  saveSession(home, { ...loadSession(home, SID)!, compactedAt: T0 + MIN })
  answerOf(pingNow, {}, ctxAt(config, T0 + 2 * MIN))
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, T0 + 2 * MIN + 1000))
  const s = loadSession(home, SID)!
  assert.equal(s.lastTurnEndAt, T0)
  assert.equal(s.gateTurnAt, undefined)
})

test('an automatic ping clears a manual flag left open', () => {
  const { home, config } = setup()
  saveSession(home, { ...loadSession(home, SID)!, pendingPing: true, pingTransport: 'fork', pingManual: true, lastPingAt: T0 + MIN })
  // Past the in-flight window, the sleeper sends its own ping.
  assert.equal(wake({ session_id: SID }, makeCtx(config, T0 + 51 * MIN, 0)), 2)
  assert.equal(loadSession(home, SID)!.pingManual, undefined)
})

test('forked (manual): a hit answers the human and its Stop is not a turn', () => {
  const { home, config, transcript } = setup()
  answerOf(pingNow, {}, ctxAt(config, T0 + 10 * MIN))
  const a = answerOf(forked, { fork: HIT }, ctxAt(config, T0 + 10 * MIN + 2000))
  assert.equal(a.action, 'none')
  assert.match((a as any).text, /pinged\. Read 91,000 cached tokens, wrote 300; cached till \d\d:\d\d\./)
  const s = loadSession(home, SID)!
  assert.equal(s.pendingPing, false)
  assert.equal(s.pingManual, undefined)
  assert.equal(s.lastPingHit, null, 'not scored')
  assert.equal(s.lastTurnEndAt, T0 + 10 * MIN + 2000)
  assert.equal(s.gateTurnAt, T0 + 10 * MIN + 2000)
  assert.deepEqual(
    readLedger(home).map((e) => [e.event, e.cacheRead]),
    [['manual-ping', 91_000]],
  )

  // The mod-answered turn's Stop leaves the fork's time alone.
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, T0 + 10 * MIN + 3000))
  assert.equal(loadSession(home, SID)!.lastTurnEndAt, T0 + 10 * MIN + 2000)
})

test('forked (manual): a cold read says so and still mutes nothing; a failed fork hands the turn to the model', () => {
  const miss = setup()
  answerOf(pingNow, {}, ctxAt(miss.config, T0 + 10 * MIN))
  assert.match((answerOf(forked, { fork: MISS }, ctxAt(miss.config, T0 + 10 * MIN)) as any).text, /nothing was read from the cache/)
  assert.equal(loadSession(miss.home, SID)!.lastPingHit, null)

  const failed = setup()
  answerOf(pingNow, {}, ctxAt(failed.config, T0 + 10 * MIN))
  // api-error is one an automatic fork sends again; a manual one never waits on a retry: the human is here.
  const a = answerOf(forked, { fork: { isAnswered: false, reason: 'api-error' } }, ctxAt(failed.config, T0 + 10 * MIN))
  assert.equal(a.action, 'turn')
  const s = loadSession(failed.home, SID)!
  assert.equal(s.forkRetries, undefined)
  assert.equal(s.pendingPing, true)
  assert.equal(s.pingTransport, 'turn')
  assert.equal(s.gateTurnAt, undefined)

  // The model's answer to commands/ping.md closes it: logged as manual, not scored.
  appendFileSync(failed.transcript, `${assistantLine({ at: T0 + 10 * MIN + 1000, read: 90_000, write: 200 })}\n`)
  record({ session_id: SID, transcript_path: failed.transcript }, makeCtx(failed.config, T0 + 10 * MIN + 2000))
  const after = loadSession(failed.home, SID)!
  assert.equal(after.pendingPing, false)
  assert.equal(after.pingManual, undefined)
  assert.equal(after.lastPingHit, null)
  assert.equal(after.lastTurnEndAt, T0 + 10 * MIN + 1000)
  assert.deepEqual(readLedger(failed.home).map((e) => e.event), ['fork-failed', 'manual-ping'])
})

test('report: manual pings cost, but are neither sent pings nor hits', () => {
  const { home, config } = setup()
  answerOf(pingNow, {}, ctxAt(config, T0 + 10 * MIN))
  answerOf(forked, { fork: HIT }, ctxAt(config, T0 + 10 * MIN))
  const s = summarize(readLedger(home), config)
  assert.equal(s.manualPings, 1)
  assert.equal(s.pings, 0)
  assert.equal(s.hits, 0)
  assert.ok(s.pingCostUsd > 0)
  assert.match(formatReport(s), /pings by hand\s+1/)
})

test('the html tag a command turn begins with is a ping', () => {
  const tag = '<command-message>cache-keeper:ping</command-message>\n<command-name>/cache-keeper:ping</command-name>'
  assert.ok(isPingCommand(tag))
  assert.ok(isPingTurn(tag))
  assert.ok(!isPingTurn('<command-name>/cache-keeper:status</command-name>'))
})

test('a mark left by a manual ping that never got its Stop does not swallow the next real turn', () => {
  const { home, config, transcript } = setup()
  answerOf(pingNow, {}, ctxAt(config, T0 + 10 * MIN))
  // Esc during the fork: no Stop. The human types again a minute later.
  touch({ session_id: SID, prompt: 'next' }, ctxAt(config, T0 + 11 * MIN))
  assert.equal(loadSession(home, SID)!.gateTurnAt, undefined)
  appendFileSync(transcript, `${assistantLine({ at: T0 + 11 * MIN + 2000, read: 90_000, write: 500 })}\n`)
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, T0 + 11 * MIN + 3000))
  assert.equal(loadSession(home, SID)!.lastTurnEndAt, T0 + 11 * MIN + 2000)
})
