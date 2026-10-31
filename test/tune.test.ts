import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wake } from '../src/commands.ts'
import { appendLedger, type LedgerEntry } from '../src/ledger.ts'
import { THRESHOLDS as T } from '../src/policy.ts'
import { formatCap } from '../src/report.ts'
import { saveSession, newSession } from '../src/state.ts'
import { decideCap, loadTuning, measuredBreakeven, positionStats, TUNE, tunedMaxPings } from '../src/tune.ts'
import { configFor, makeCtx, SID, tempHome } from './helpers.ts'

const T0 = Date.parse('2026-03-01T10:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

/** `n` stretches in distinct sessions, each pinged `pings` times, resumed warm or abandoned. */
function stretches(n: number, pings: number, resumedWarm: boolean, tag: string): LedgerEntry[] {
  const out: LedgerEntry[] = []
  for (let i = 0; i < n; i++) {
    const sessionId = `${tag}-${i}`
    for (let k = 1; k <= pings; k++) out.push({ t: iso(T0), sessionId, event: 'ping' })
    if (resumedWarm) out.push({ t: iso(T0), sessionId, event: 'resume', pings, lastPingHit: true, ageSec: 600 })
  }
  return out
}

test('positionStats: counts pings per position and warm resumes after the last one', () => {
  const L = [
    ...stretches(3, 1, true, 'a'),
    ...stretches(2, 2, true, 'b'),
    ...stretches(5, 2, false, 'c'),
    // resumed after the cache was gone: not warm
    { t: iso(T0), sessionId: 'd', event: 'ping' as const },
    { t: iso(T0), sessionId: 'd', event: 'resume' as const, pings: 1, lastPingHit: true, ageSec: 4000 },
  ]
  assert.deepEqual(positionStats(L, 3600), [
    { k: 1, sent: 11, warm: 3 },
    { k: 2, sent: 7, warm: 2 },
  ])
})

test('positionStats: a ping line that carries its position wins over counting', () => {
  const L: LedgerEntry[] = [{ t: iso(T0), sessionId: 'a', event: 'ping', pings: 3 }]
  assert.deepEqual(positionStats(L, 3600), [{ k: 3, sent: 1, warm: 0 }])
})

test('measuredBreakeven: wake cost over the rewrite it avoids; default without data', () => {
  assert.equal(measuredBreakeven([]), TUNE.defaultBreakeven)
  const hit: LedgerEntry = { t: iso(T0), sessionId: 'a', event: 'wake-hit', ctxTokens: 100_000, cacheRead: 100_000, cacheWrite: 1000, outputTokens: 0 }
  // (100k * 0.1 + 1k * 2) / (100k * 1.9)
  assert.ok(Math.abs(measuredBreakeven([hit]) - 12_000 / 190_000) < 1e-9)
})

test('decideCap: holds without enough samples at the cap', () => {
  const d = decideCap(4, [{ k: 4, sent: TUNE.minSamples - 1, warm: 20 }], 0.05)
  assert.equal(d.maxPings, 4)
  assert.equal(d.step, 'hold')
})

test('decideCap: up when the last ping clears breakeven with the margin, down when it does not clear it', () => {
  const n = 100
  assert.equal(decideCap(4, [{ k: 4, sent: n, warm: 19 }], 0.05).maxPings, 5)
  assert.equal(decideCap(4, [{ k: 4, sent: n, warm: 7 }], 0.05).maxPings, 4, 'between breakeven and the margin: hold')
  assert.equal(decideCap(4, [{ k: 4, sent: n, warm: 4 }], 0.05).maxPings, 3)
})

test('decideCap: stays inside its bounds', () => {
  assert.equal(decideCap(TUNE.max, [{ k: TUNE.max, sent: 100, warm: 90 }], 0.05).maxPings, TUNE.max)
  assert.equal(decideCap(TUNE.min, [{ k: TUNE.min, sent: 100, warm: 0 }], 0.05).maxPings, TUNE.min)
  assert.equal(decideCap(50, [], 0.05).maxPings, TUNE.max, 'a corrupt value is clamped')
})

test('tunedMaxPings: one step per interval, the file remembers it', () => {
  const home = tempHome()
  const config = configFor(home)
  for (const e of stretches(40, 4, true, 'w')) appendLedger(home, e)
  assert.equal(tunedMaxPings(config, T0 + 1000), 5)
  assert.equal(loadTuning(home)!.from, 4)
  // a day later the 5th position has no samples yet: hold
  assert.equal(tunedMaxPings(config, T0 + 1000 + 3600_000), 5, 'within the interval: cached')
  assert.equal(tunedMaxPings(config, T0 + 1000 + TUNE.intervalMs), 5)
  assert.equal(loadTuning(home)!.step, 'hold')
})

test('tunedMaxPings: ledger lines older than the window do not count', () => {
  const home = tempHome()
  for (const e of stretches(40, 4, true, 'old')) appendLedger(home, e)
  assert.equal(tunedMaxPings(configFor(home), T0 + TUNE.windowMs + 1), T.maxPings)
})

test('wake: an explicit maxPings turns the tuner off', () => {
  const home = tempHome()
  for (const e of stretches(40, 4, true, 'w')) appendLedger(home, e)
  const config = configFor(home, { CACHE_KEEPER_MAX_PINGS: '4' })
  assert.equal(config.maxPingsAuto, false)
  saveSession(home, { ...newSession(SID), lastTurnEndAt: T0, ctxTokens: 100_000, pingsSoFar: 4 })
  assert.equal(wake({ session_id: SID }, makeCtx(config, T0 + (T.minAgeSec + 60) * 1000)), 0)
  assert.equal(loadTuning(home), undefined)
})

test('wake: the tuned cap lets a 5th ping out', () => {
  const home = tempHome()
  for (const e of stretches(40, 4, true, 'w')) appendLedger(home, e)
  const config = configFor(home)
  saveSession(home, { ...newSession(SID), lastTurnEndAt: T0, ctxTokens: 100_000, pingsSoFar: 4 })
  assert.equal(wake({ session_id: SID }, makeCtx(config, T0 + (T.minAgeSec + 60) * 1000)), 2)
})

test('formatCap: says where the cap came from', () => {
  assert.match(formatCap({ maxPings: 4, auto: false }), /set in config/)
  assert.match(formatCap({ maxPings: 4, auto: true }), /not computed yet/)
  assert.match(formatCap({ maxPings: 5, auto: true, step: 'up', from: 4, why: 'x' }), /5 \(auto, up from 4: x\)/)
})
