import { test } from 'node:test'
import assert from 'node:assert/strict'
import { format, lineOf } from '../hooks/status.ts'

const T = 1_800_000_000_000
const MIN = 60_000
const session = (over: Record<string, unknown> = {}) => ({ ctxTokens: 50_000, pingsSoFar: 1, lastTurnEndAt: T, ...over })

test('a warm cache with pings left extends, and shows how many are left', () => {
  const l = lineOf(session(), { maxPings: 4 }, {}, T + 10 * MIN)
  assert.deepEqual(l, { left: 3, extends: true, warmUntil: T + 60 * MIN })
  assert.equal(format(l!, 0), 'cache ↻³ 09:00')
})

test('two-digit counts are all superscript', () => {
  assert.equal(format({ left: 12, extends: true, warmUntil: T }, 0), 'cache ↻¹² 08:00')
})

test('the time is local: the offset is applied', () => {
  // getTimezoneOffset() is UTC − local in minutes: −120 is UTC+2.
  assert.equal(format({ left: 1, extends: true, warmUntil: T }, -120), 'cache ↻¹ 10:00')
})

test('no ping left, a small context or a muted session make the deadline final', () => {
  assert.equal(format(lineOf(session({ pingsSoFar: 4 }), { maxPings: 4 }, {}, T)!, 0), 'cache → 09:00')
  assert.equal(lineOf(session({ ctxTokens: 1000 }), {}, {}, T)!.extends, false)
  assert.equal(lineOf(session({ doneAt: T }), {}, {}, T)!.extends, false)
  assert.equal(lineOf(session({ pingsSoFar: 9 }), { maxPings: 4 }, {}, T)!.left, 0)
})

test('the last ping counts as the last request', () => {
  assert.equal(lineOf(session({ lastPingAt: T + 30 * MIN }), {}, {}, T + 70 * MIN)!.warmUntil, T + 90 * MIN)
})

test('the env cap wins over config.json, as in keeper itself', () => {
  assert.equal(lineOf(session(), { maxPings: 4 }, { maxPings: '2' }, T)!.left, 1)
  assert.equal(lineOf(session(), { maxPings: 4 }, { maxPings: 'x' }, T)!.left, 3)
  assert.equal(lineOf(session(), { minCtxTokens: 1000 }, { minCtxTokens: '60000' }, T)!.extends, false)
})

test('without a cap in env or config.json, the tuned one counts', () => {
  assert.equal(lineOf(session(), {}, {}, T, { maxPings: 6 })!.left, 5)
  assert.equal(lineOf(session(), { maxPings: 2 }, {}, T, { maxPings: 6 })!.left, 1)
  assert.equal(lineOf(session(), {}, {}, T)!.left, 3)
})

test('nothing is shown when cold, off, disabled or without a record', () => {
  assert.equal(lineOf(session(), {}, {}, T + 60 * MIN), undefined)
  assert.equal(lineOf(session(), { cacheTtlSec: 300 }, {}, T + 6 * MIN), undefined)
  assert.equal(lineOf(session(), { statusLine: false }, {}, T), undefined)
  assert.equal(lineOf(session(), { enabled: false }, {}, T), undefined)
  assert.equal(lineOf(session(), {}, { disabled: '1' }, T), undefined)
  assert.equal(lineOf(undefined, {}, {}, T), undefined)
  assert.equal(lineOf({ pingsSoFar: 0 }, {}, {}, T), undefined)
})
