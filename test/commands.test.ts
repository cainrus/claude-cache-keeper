import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { end, isWakePrompt, record, touch, TRANSCRIPT_CATCH_UP_MS, wake, WAKE_MESSAGE } from '../src/commands.ts'
import { readLedger } from '../src/ledger.ts'
import { THRESHOLDS as T } from '../src/policy.ts'
import { loadAwayBudget, loadSession, newSession, saveAwayBudget, saveSession } from '../src/state.ts'
import { assistantLine, configFor, FIXTURES, makeCtx, MIN, SID, tempHome, writeTranscript } from './helpers.ts'

const T0 = Date.parse('2026-01-01T10:00:00.000Z')
const BIG = { read: 90_000, write: 1_000 }
const WARM_ENOUGH = (T.minAgeSec + 60) * 1000

/** A session whose last turn ended at T0 with a large context. */
function setup(env: Record<string, string> = {}) {
  const home = tempHome()
  const config = configFor(home, env)
  const transcript = writeTranscript(home, [{ at: T0, ...BIG }])
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, T0 + 500))
  return { home, config, transcript }
}

// --- record ------------------------------------------------------------------

test('record: cache age starts at the last assistant entry, not at the hook clock', () => {
  const { home } = setup()
  const s = loadSession(home, SID)!
  assert.equal(s.lastTurnEndAt, T0)
  assert.equal(s.ctxTokens, 5 + BIG.read + BIG.write)
  assert.equal(s.model, 'claude-opus-4-5')
})

test('record: an entry older than the last prompt means the transcript lags — use now', () => {
  const home = tempHome()
  const config = configFor(home)
  saveSession(home, { ...newSession(SID), lastHumanAt: T0 + 10 * MIN })
  const transcript = writeTranscript(home, [{ at: T0, ...BIG }])
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, T0 + 11 * MIN))
  assert.equal(loadSession(home, SID)!.lastTurnEndAt, T0 + 11 * MIN)
})

// Seen live: the Stop closing the second wake ran before the wake's assistant
// entry reached the disk, and the previous wake's usage was scored in its place.
test('record: waits for the wake turn to reach the transcript instead of scoring the previous one', () => {
  const home = tempHome()
  const config = configFor(home)
  const pingAt = T0 + 50 * MIN
  saveSession(home, { ...newSession(SID), pendingPing: true, lastPingAt: pingAt })
  const transcript = writeTranscript(home, [{ at: T0, read: 57_225, write: 889 }])
  const ctx = makeCtx(config, pingAt + 3_000)
  ctx.sleepMs = (ms) => {
    ctx.slept += ms
    appendFileSync(transcript, `${assistantLine({ at: pingAt + 1_500, read: 58_114, write: 765 })}\n`)
  }
  record({ session_id: SID, transcript_path: transcript }, ctx)
  const hit = readLedger(home).find((e) => e.event === 'wake-hit')
  assert.ok(hit)
  assert.equal(hit.cacheRead, 58_114)
  assert.equal(hit.cacheWrite, 765)
  assert.equal(loadSession(home, SID)!.lastTurnEndAt, pingAt + 1_500)
})

test('record: a wake turn that never reaches the transcript is left unscored', () => {
  const home = tempHome()
  const config = configFor(home)
  const pingAt = T0 + 50 * MIN
  saveSession(home, { ...newSession(SID), pendingPing: true, lastPingAt: pingAt })
  const transcript = writeTranscript(home, [{ at: T0, read: 57_225, write: 889 }])
  const ctx = makeCtx(config, pingAt + 3_000)
  record({ session_id: SID, transcript_path: transcript }, ctx)
  assert.equal(ctx.slept, TRANSCRIPT_CATCH_UP_MS)
  assert.deepEqual(readLedger(home).filter((e) => String(e.event).startsWith('wake-')), [])
  const s = loadSession(home, SID)!
  assert.equal(s.pendingPing, false)
  assert.equal(s.lastPingHit, null)
})

test('record: without a transcript it still stamps the turn', () => {
  const home = tempHome()
  record({ session_id: SID }, makeCtx(configFor(home), T0))
  assert.equal(loadSession(home, SID)!.lastTurnEndAt, T0)
  assert.equal(record({}, makeCtx(configFor(home), T0)), 0)
})

test('record: the oracle scores a wake turn as a hit (fixture: 57k read / 911 written)', () => {
  const home = tempHome()
  const config = configFor(home)
  saveSession(home, { ...newSession(SID), pendingPing: true, pingsSoFar: 1 })
  record(
    { session_id: SID, transcript_path: join(FIXTURES, 'wake-hit.jsonl'), stop_hook_active: true },
    makeCtx(config, T0 + 51 * MIN),
  )
  const s = loadSession(home, SID)!
  assert.equal(s.lastPingHit, true)
  assert.equal(s.pendingPing, false)
  const [line] = readLedger(home)
  assert.equal(line.event, 'wake-hit')
  assert.equal(line.cacheRead, 57_129)
  assert.equal(line.cacheWrite, 911)
})

test('record: the oracle scores a full rewrite as a miss, which mutes the session', () => {
  const home = tempHome()
  const config = configFor(home)
  saveSession(home, { ...newSession(SID), pendingPing: true, pingsSoFar: 1 })
  record({ session_id: SID, transcript_path: join(FIXTURES, 'wake-miss.jsonl') }, makeCtx(config, T0))
  assert.equal(loadSession(home, SID)!.lastPingHit, false)
  assert.equal(readLedger(home)[0].event, 'wake-miss')
})

test('record: the hit ratio threshold is inclusive and configurable', () => {
  const home = tempHome()
  const transcript = writeTranscript(home, [{ at: T0, read: 90, write: 10 }])
  for (const [ratio, hit] of [['0.9', true], ['0.91', false]] as const) {
    saveSession(home, { ...newSession(SID), pendingPing: true })
    record({ session_id: SID, transcript_path: transcript }, makeCtx(configFor(home, { CACHE_KEEPER_HIT_RATIO: ratio }), T0))
    assert.equal(loadSession(home, SID)!.lastPingHit, hit, `ratio ${ratio}`)
  }
})

test('record: stop_hook_active without our pending wake is not scored', () => {
  const home = tempHome()
  const config = configFor(home)
  record({ session_id: SID, transcript_path: join(FIXTURES, 'wake-miss.jsonl'), stop_hook_active: true }, makeCtx(config, T0))
  assert.equal(loadSession(home, SID)!.lastPingHit, null)
  assert.deepEqual(readLedger(home), [])
})

// --- wake --------------------------------------------------------------------

test('wake: pings an idle session — exit 2, message on stderr, state and ledger updated', () => {
  const { home, config } = setup()
  const ctx = makeCtx(config, T0 + WARM_ENOUGH, 30)
  assert.equal(wake({ session_id: SID }, ctx), 2)
  assert.deepEqual(ctx.errors, [`${WAKE_MESSAGE}\n`])
  const s = loadSession(home, SID)!
  assert.equal(s.pingsSoFar, 1)
  assert.equal(s.pendingPing, true)
  assert.equal(s.lastPingAt, T0 + WARM_ENOUGH)
  const [line] = readLedger(home)
  assert.equal(line.event, 'ping')
  assert.equal(line.ageSec, T.minAgeSec + 60)
  assert.equal(line.awaySeconds, 30)
})

test('wake: a stale sleeper (a newer turn ended since) exits 0 silently', () => {
  const { home, config } = setup()
  const ctx = makeCtx(config, T0 + (T.minAgeSec - 1) * 1000)
  assert.equal(wake({ session_id: SID }, ctx), 0)
  assert.deepEqual(ctx.errors, [])
  assert.equal(ctx.probes, 0, 'no presence probe for a stale sleeper')
  assert.deepEqual(readLedger(home), [])
})

test('wake: a turn that started after the last Stop makes the sleeper stale', () => {
  const { home, config } = setup()
  touch({ session_id: SID, prompt: 'next task' }, makeCtx(config, T0 + 5 * MIN))
  assert.equal(wake({ session_id: SID }, makeCtx(config, T0 + WARM_ENOUGH)), 0)
  assert.deepEqual(readLedger(home), [])
})

test('wake: no state (session ended) or no session id exits 0', () => {
  const home = tempHome()
  const config = configFor(home)
  assert.equal(wake({ session_id: SID }, makeCtx(config, T0)), 0)
  assert.equal(wake({}, makeCtx(config, T0)), 0)
})

test('wake: disabled by env exits 0 without touching anything', () => {
  const { home } = setup()
  const ctx = makeCtx(configFor(home, { CACHE_KEEPER_DISABLED: '1' }), T0 + WARM_ENOUGH)
  assert.equal(wake({ session_id: SID }, ctx), 0)
  assert.deepEqual(readLedger(home), [])
})

test('wake: a refusal is logged with its reason and exits 0', () => {
  const { home, config } = setup()
  const ctx = makeCtx(config, T0 + WARM_ENOUGH, T.awaySec + 1)
  assert.equal(wake({ session_id: SID }, ctx), 0)
  assert.deepEqual(ctx.errors, [])
  const [line] = readLedger(home)
  assert.equal(line.event, 'skip')
  assert.equal(line.reason, 'away')
})

// --- away budget -------------------------------------------------------------

test('away budget: a ping while away spends it, a ping at the keyboard does not', () => {
  const away = setup()
  wake({ session_id: SID }, makeCtx(away.config, T0 + WARM_ENOUGH, T.presenceSec + 1))
  assert.equal(loadAwayBudget(away.home).awayPingsSincePresence, 1)

  const here = setup()
  wake({ session_id: SID }, makeCtx(here.config, T0 + WARM_ENOUGH, T.presenceSec))
  assert.equal(loadAwayBudget(here.home).awayPingsSincePresence, 0)
})

test('away budget: an unknown probe spends it', () => {
  const { home, config } = setup()
  assert.equal(wake({ session_id: SID }, makeCtx(config, T0 + WARM_ENOUGH, null)), 2)
  assert.equal(loadAwayBudget(home).awayPingsSincePresence, 1)
})

test('away budget: once spent, every session is refused until presence refills it', () => {
  const { home, config } = setup()
  saveAwayBudget(home, { awayPingsSincePresence: T.maxAwayPings })
  assert.equal(wake({ session_id: SID }, makeCtx(config, T0 + WARM_ENOUGH, T.presenceSec + 1)), 0)
  assert.equal(readLedger(home).at(-1)?.reason, 'away-budget-spent')

  // Presence observed: refilled, and this ping (at the keyboard) is free.
  assert.equal(wake({ session_id: SID }, makeCtx(config, T0 + WARM_ENOUGH, 10)), 2)
  assert.equal(loadAwayBudget(home).awayPingsSincePresence, 0)
})

test('away budget: shared by all sessions of the machine', () => {
  const home = tempHome()
  const config = configFor(home)
  const transcript = writeTranscript(home, [{ at: T0, ...BIG }])
  const ids = Array.from({ length: T.maxAwayPings + 2 }, (_, i) => `session-${i}`)
  const codes = ids.map((id) => {
    record({ session_id: id, transcript_path: transcript }, makeCtx(config, T0))
    return wake({ session_id: id }, makeCtx(config, T0 + WARM_ENOUGH, T.presenceSec + 1))
  })
  assert.equal(codes.filter((c) => c === 2).length, T.maxAwayPings)
  assert.equal(loadAwayBudget(home).awayPingsSincePresence, T.maxAwayPings)
})

// --- touch / end -------------------------------------------------------------

test('touch: a real prompt resets the stretch and logs the resume', () => {
  const { home, config } = setup()
  wake({ session_id: SID }, makeCtx(config, T0 + WARM_ENOUGH))
  touch({ session_id: SID, prompt: 'back to work' }, makeCtx(config, T0 + WARM_ENOUGH + MIN))
  const s = loadSession(home, SID)!
  assert.equal(s.pingsSoFar, 0)
  assert.equal(s.pendingPing, false)
  assert.equal(s.lastHumanAt, T0 + WARM_ENOUGH + MIN)
  const resume = readLedger(home).at(-1)!
  assert.equal(resume.event, 'resume')
  assert.equal(resume.pings, 1)
})

test('touch: the wake turn\'s own prompt is ignored', () => {
  const { home, config } = setup()
  wake({ session_id: SID }, makeCtx(config, T0 + WARM_ENOUGH))
  touch({ session_id: SID, prompt: `Stop hook feedback:\n${WAKE_MESSAGE}` }, makeCtx(config, T0 + WARM_ENOUGH + 1000))
  const s = loadSession(home, SID)!
  assert.equal(s.pingsSoFar, 1)
  assert.equal(s.pendingPing, true)
  assert.equal(s.lastHumanAt, undefined)
  assert.equal(readLedger(home).length, 1)
  assert.ok(isWakePrompt(WAKE_MESSAGE))
  assert.ok(!isWakePrompt('ok'))
})

test('touch: no resume line for a stretch without pings; creates state for a new session', () => {
  const home = tempHome()
  touch({ session_id: SID, prompt: 'hi' }, makeCtx(configFor(home), T0))
  assert.equal(loadSession(home, SID)!.lastHumanAt, T0)
  assert.deepEqual(readLedger(home), [])
})

test('end: deletes the session state; a sleeper afterwards finds nothing', () => {
  const { home, config } = setup()
  end({ session_id: SID }, makeCtx(config, T0))
  assert.equal(loadSession(home, SID), undefined)
  assert.equal(wake({ session_id: SID }, makeCtx(config, T0 + WARM_ENOUGH)), 0)
})

// --- the whole loop ----------------------------------------------------------

test('loop: pings every ~50 min while hits keep landing, stops at the per-stretch budget', () => {
  const home = tempHome()
  const config = configFor(home)
  let t = T0
  let transcript = writeTranscript(home, [{ at: t, ...BIG }])
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, t))

  const codes: number[] = []
  for (let i = 0; i < T.maxPings + 1; i++) {
    t += WARM_ENOUGH
    const code = wake({ session_id: SID }, makeCtx(config, t, 60))
    codes.push(code)
    if (code !== 2) break
    // The wake turn lands a few seconds later and its Stop is recorded.
    transcript = writeTranscript(home, [{ at: t + 3000, read: 91_000, write: 200 }])
    record({ session_id: SID, transcript_path: transcript, stop_hook_active: true }, makeCtx(config, t + 3500))
    t += 3000
  }
  assert.deepEqual(codes, [...Array(T.maxPings).fill(2), 0])
  const events = readLedger(home).map((e) => e.event)
  assert.equal(events.filter((e) => e === 'wake-hit').length, T.maxPings)
  assert.equal(readLedger(home).at(-1)?.reason, 'budget-spent')
})
