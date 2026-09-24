import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, isAtKeyboard, SKIP_REASONS, THRESHOLDS, type PolicyInput, type Thresholds } from '../src/policy.ts'

const T = THRESHOLDS

/** A state that pings: present, big context, cache in its last stretch. */
const OK: PolicyInput = {
  awaySeconds: 60,
  ageSec: T.minAgeSec + 60,
  ctxTokens: T.minCtxTokens * 4,
  pingsSoFar: 0,
  awayPingsSincePresence: 0,
  lastPingHit: null,
}

/** Away enough for the away budget to apply, not so far that `away` fires. */
const AWAY: PolicyInput = { ...OK, awaySeconds: T.presenceSec + 1 }

const reason = (s: PolicyInput, t?: Thresholds) => {
  const d = decide(s, t)
  return d.ping ? 'ping' : d.reason
}

test('the baseline state pings', () => {
  assert.deepEqual(decide(OK), { ping: true })
})

test('thresholds keep their documented relations', () => {
  assert.ok(T.presenceSec < T.awaySec)
  assert.ok(T.minAgeSec < T.maxAgeSec)
  assert.ok(T.maxAgeSec < 3600, 'maxAgeSec must stay inside the 1h TTL')
  assert.ok(Object.isFrozen(T))
})

// --- 1. away -----------------------------------------------------------------

test('away: refused above the threshold, not at it', () => {
  assert.equal(reason({ ...OK, awaySeconds: T.awaySec }), 'ping')
  assert.equal(reason({ ...OK, awaySeconds: T.awaySec + 1 }), 'away')
})

test('away: an unknown probe is not "gone"', () => {
  assert.equal(reason({ ...OK, awaySeconds: null }), 'ping')
})

// --- 2. away budget ----------------------------------------------------------

test('away budget: not consulted while at the keyboard', () => {
  assert.equal(reason({ ...OK, awayPingsSincePresence: 999 }), 'ping')
})

test('away budget: presence is measured above presenceSec, not at it', () => {
  const spent = { awayPingsSincePresence: T.maxAwayPings }
  assert.equal(reason({ ...OK, ...spent, awaySeconds: T.presenceSec }), 'ping')
  assert.equal(reason({ ...OK, ...spent, awaySeconds: T.presenceSec + 1 }), 'away-budget-spent')
})

test('away budget: the last ping is allowed, the next one refused', () => {
  assert.equal(reason({ ...AWAY, awayPingsSincePresence: T.maxAwayPings - 1 }), 'ping')
  assert.equal(reason({ ...AWAY, awayPingsSincePresence: T.maxAwayPings }), 'away-budget-spent')
})

test('away budget: an unknown probe counts as NOT at the keyboard', () => {
  const unknown = { ...OK, awaySeconds: null }
  assert.equal(reason({ ...unknown, awayPingsSincePresence: T.maxAwayPings - 1 }), 'ping')
  assert.equal(reason({ ...unknown, awayPingsSincePresence: T.maxAwayPings }), 'away-budget-spent')
})

// --- 3..7 --------------------------------------------------------------------

test('context too small', () => {
  assert.equal(reason({ ...OK, ctxTokens: T.minCtxTokens - 1 }), 'context-too-small')
  assert.equal(reason({ ...OK, ctxTokens: T.minCtxTokens }), 'ping')
})

test('cache expired: at maxAgeSec and beyond', () => {
  assert.equal(reason({ ...OK, ageSec: T.maxAgeSec - 1 }), 'ping')
  assert.equal(reason({ ...OK, ageSec: T.maxAgeSec }), 'cache-expired')
  assert.equal(reason({ ...OK, ageSec: 3 * 3600 }), 'cache-expired')
})

test('cache still warm: below minAgeSec', () => {
  assert.equal(reason({ ...OK, ageSec: T.minAgeSec - 1 }), 'cache-still-warm')
  assert.equal(reason({ ...OK, ageSec: T.minAgeSec }), 'ping')
})

test('per-stretch budget', () => {
  assert.equal(reason({ ...OK, pingsSoFar: T.maxPings - 1 }), 'ping')
  assert.equal(reason({ ...OK, pingsSoFar: T.maxPings }), 'budget-spent')
})

test('oracle: a miss mutes the session, no ping yet or a hit does not', () => {
  assert.equal(reason({ ...OK, lastPingHit: false }), 'oracle-miss')
  assert.equal(reason({ ...OK, lastPingHit: null }), 'ping')
  assert.equal(reason({ ...OK, lastPingHit: true }), 'ping')
})

// --- branch order ------------------------------------------------------------

/** Every gate failing at once; each step below repairs the gate that won. */
const WORST: PolicyInput = {
  awaySeconds: T.awaySec + 1,
  ageSec: T.maxAgeSec,
  ctxTokens: 0,
  pingsSoFar: T.maxPings,
  awayPingsSincePresence: T.maxAwayPings,
  lastPingHit: false,
}

test('branch order: repairing each winning gate exposes the next one, in SKIP_REASONS order', () => {
  const repairs: Array<(s: PolicyInput) => PolicyInput> = [
    (s) => ({ ...s, awaySeconds: T.presenceSec + 1 }), // away -> still not at keyboard
    (s) => ({ ...s, awayPingsSincePresence: 0 }),
    (s) => ({ ...s, ctxTokens: T.minCtxTokens }),
    (s) => ({ ...s, ageSec: 0 }), // expired -> still warm
    (s) => ({ ...s, ageSec: T.minAgeSec }),
    (s) => ({ ...s, pingsSoFar: 0 }),
    (s) => ({ ...s, lastPingHit: true }),
  ]
  const seen: string[] = []
  let s = WORST
  for (const repair of repairs) {
    seen.push(reason(s))
    s = repair(s)
  }
  seen.push(reason(s))
  assert.deepEqual(seen, [...SKIP_REASONS, 'ping'])
})

test('branch order: a dead cache outranks the still-warm check and the budgets', () => {
  assert.equal(reason({ ...OK, ageSec: T.maxAgeSec, pingsSoFar: 99, lastPingHit: false }), 'cache-expired')
})

test('custom thresholds are honoured', () => {
  const t: Thresholds = { ...T, minCtxTokens: 10, minAgeSec: 1, maxAgeSec: 10 }
  assert.equal(reason({ ...OK, ctxTokens: 10, ageSec: 5 }, t), 'ping')
  assert.equal(reason({ ...OK, ctxTokens: 10, ageSec: 10 }, t), 'cache-expired')
})

test('isAtKeyboard', () => {
  assert.equal(isAtKeyboard(null), false)
  assert.equal(isAtKeyboard(0), true)
  assert.equal(isAtKeyboard(T.presenceSec), true)
  assert.equal(isAtKeyboard(T.presenceSec + 1), false)
})
