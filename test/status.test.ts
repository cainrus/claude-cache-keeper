import { test } from 'node:test'
import assert from 'node:assert/strict'
import { format, lineOf, nodeOk } from '../hooks/status.ts'

const T = 1_800_000_000_000
const MIN = 60_000
const session = (over: Record<string, unknown> = {}) => ({ ctxTokens: 50_000, pingsSoFar: 1, lastTurnEndAt: T, ...over })
const cached = (left: number, ext: boolean, warmUntil: number) => ({ kind: 'cached' as const, left, extends: ext, warmUntil })
const pick = (l: ReturnType<typeof lineOf>) => {
  assert.equal(l?.kind, 'cached')
  return l as ReturnType<typeof cached>
}

test('a warm cache with pings left extends, and shows how many are left', () => {
  const l = lineOf(session(), { maxPings: 4 }, {}, T + 10 * MIN)
  assert.deepEqual(l, cached(3, true, T + 60 * MIN))
  assert.equal(format(l!, 0), 'cached till 09:00 · renews ×3')
})

test('two-digit counts print as they are', () => {
  assert.equal(format(cached(12, true, T), 0), 'cached till 08:00 · renews ×12')
})

test('the time is local: the offset is applied', () => {
  // getTimezoneOffset() is UTC − local in minutes: −120 is UTC+2.
  assert.equal(format(cached(1, true, T), -120), 'cached till 10:00 · renews ×1')
})

test('no ping left, a small context or a muted session make the deadline final', () => {
  assert.equal(format(lineOf(session({ pingsSoFar: 4 }), { maxPings: 4 }, {}, T)!, 0), 'cached till 09:00')
  assert.equal(pick(lineOf(session({ ctxTokens: 1000 }), {}, {}, T)).extends, false)
  assert.equal(pick(lineOf(session({ doneAt: T }), {}, {}, T)).extends, false)
  assert.equal(pick(lineOf(session({ pingsSoFar: 9 }), { maxPings: 4 }, {}, T)).left, 0)
})

test('the last ping counts as the last request', () => {
  assert.equal(pick(lineOf(session({ lastPingAt: T + 30 * MIN }), {}, {}, T + 70 * MIN)).warmUntil, T + 90 * MIN)
})

test('the env cap wins over config.json, as in keeper itself', () => {
  assert.equal(pick(lineOf(session(), { maxPings: 4 }, { maxPings: '2' }, T)).left, 1)
  assert.equal(pick(lineOf(session(), { maxPings: 4 }, { maxPings: 'x' }, T)).left, 3)
  assert.equal(pick(lineOf(session(), { minCtxTokens: 1000 }, { minCtxTokens: '60000' }, T)).extends, false)
})

test('without a cap in env or config.json, the tuned one counts', () => {
  assert.equal(pick(lineOf(session(), {}, {}, T, { maxPings: 6 })).left, 5)
  assert.equal(pick(lineOf(session(), { maxPings: 2 }, {}, T, { maxPings: 6 })).left, 1)
  assert.equal(pick(lineOf(session(), {}, {}, T)).left, 3)
})

test('before anything was sent, keeper says it is ready', () => {
  assert.deepEqual(lineOf(undefined, {}, {}, T), { kind: 'ready' })
  assert.deepEqual(lineOf({ pingsSoFar: 0 }, {}, {}, T), { kind: 'ready' })
  assert.equal(format({ kind: 'ready' }, 0), 'ready')
})

test('a cold cache after a turn says so', () => {
  assert.deepEqual(lineOf(session(), {}, {}, T + 60 * MIN), { kind: 'expired' })
  assert.deepEqual(lineOf(session(), { cacheTtlSec: 300 }, {}, T + 6 * MIN), { kind: 'expired' })
  assert.equal(format({ kind: 'expired' }, 0), 'cache expired')
})

test('nothing is shown when off or disabled', () => {
  assert.equal(lineOf(session(), { statusLine: false }, {}, T), undefined)
  assert.equal(lineOf(session(), { enabled: false }, {}, T), undefined)
  assert.equal(lineOf(session(), {}, { disabled: '1' }, T), undefined)
  assert.equal(lineOf(undefined, { statusLine: false }, {}, T), undefined)
})

test('node versions that run .ts without a flag', () => {
  for (const v of ['v22.18.0', 'v22.20.1\n', 'v23.6.0', 'v24.0.0', 'v26.3.1']) assert.equal(nodeOk(v), true, v)
  for (const v of ['v22.17.9', 'v23.5.0', 'v20.19.0', 'v18.0.0', '', 'node: not found']) assert.equal(nodeOk(v), false, v)
})
