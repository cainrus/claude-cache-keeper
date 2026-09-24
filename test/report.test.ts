import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PRICES } from '../src/config.ts'
import type { LedgerEntry } from '../src/ledger.ts'
import { basePrice, formatReport, MULT, savedUsd, summarize, wakeCostUsd } from '../src/report.ts'

const cfg = { prices: DEFAULT_PRICES, cacheTtlSec: 3600 }
const t = (m: number) => new Date(Date.UTC(2026, 0, 1, 10, m)).toISOString()

test('basePrice matches the model family, falls back to default', () => {
  assert.equal(basePrice('claude-opus-4-5', DEFAULT_PRICES), DEFAULT_PRICES.opus)
  assert.equal(basePrice('claude-sonnet-4-5', DEFAULT_PRICES), DEFAULT_PRICES.sonnet)
  assert.equal(basePrice('claude-haiku-4-5', DEFAULT_PRICES), DEFAULT_PRICES.haiku)
  assert.equal(basePrice(undefined, DEFAULT_PRICES), DEFAULT_PRICES.default)
})

test('wake cost and saved rewrite use the standard multipliers', () => {
  const wakeLine: LedgerEntry = {
    t: t(0), sessionId: 'a', event: 'wake-hit', model: 'claude-opus-4-5',
    inputTokens: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, outputTokens: 1_000_000,
  }
  const perM = DEFAULT_PRICES.opus
  assert.equal(wakeCostUsd(wakeLine, DEFAULT_PRICES), perM * (MULT.input + MULT.cacheRead + MULT.cacheWrite + MULT.output))
  const resume: LedgerEntry = { t: t(0), sessionId: 'a', event: 'resume', ctxTokens: 200_000, model: 'claude-opus-4-5' }
  assert.equal(savedUsd(resume, DEFAULT_PRICES), 0.2 * perM * (MULT.cacheWrite - MULT.cacheRead))
})

test('summarize: counts, stretches, refusals and balance', () => {
  const opus = 'claude-opus-4-5'
  const L: LedgerEntry[] = [
    // session a: two pings, both hit, resumed while warm -> one saved rewrite
    { t: t(0), sessionId: 'a', event: 'ping', ctxTokens: 100_000 },
    { t: t(1), sessionId: 'a', event: 'wake-hit', model: opus, cacheRead: 100_000, cacheWrite: 500, outputTokens: 5 },
    { t: t(2), sessionId: 'a', event: 'ping', ctxTokens: 100_000 },
    { t: t(3), sessionId: 'a', event: 'wake-hit', model: opus, cacheRead: 100_000, cacheWrite: 500, outputTokens: 5 },
    { t: t(4), sessionId: 'a', event: 'resume', pings: 2, lastPingHit: true, ageSec: 600, ctxTokens: 100_000, model: opus },
    // session b: a miss, then resumed too late to count as saved
    { t: t(5), sessionId: 'b', event: 'ping' },
    { t: t(6), sessionId: 'b', event: 'wake-miss', model: opus, cacheRead: 0, cacheWrite: 50_000, outputTokens: 5 },
    { t: t(7), sessionId: 'b', event: 'skip', reason: 'oracle-miss' },
    { t: t(8), sessionId: 'b', event: 'resume', pings: 1, lastPingHit: false, ageSec: 5000, ctxTokens: 50_000, model: opus },
    // session c: pinged, never came back; one ping never scored
    { t: t(9), sessionId: 'c', event: 'ping' },
    { t: t(10), sessionId: 'c', event: 'skip', reason: 'away' },
    { t: t(11), sessionId: 'd', event: 'skip', reason: 'away' },
  ]
  const s = summarize(L, cfg)
  assert.equal(s.entries, L.length)
  assert.equal(s.pings, 4)
  assert.equal(s.hits, 2)
  assert.equal(s.misses, 1)
  assert.equal(s.unscored, 1)
  assert.equal(s.resumedAfterPing, 2)
  assert.equal(s.savedRewrites, 1)
  assert.equal(s.abandoned, 1)
  assert.deepEqual(s.refusals, { 'oracle-miss': 1, away: 2 })
  assert.equal(s.refusalsTotal, 3)

  const expectedSaved = savedUsd(L[4], DEFAULT_PRICES)
  const expectedCost = [L[1], L[3], L[6]].reduce((sum, e) => sum + wakeCostUsd(e, DEFAULT_PRICES), 0)
  assert.equal(s.savedUsd, expectedSaved)
  assert.ok(Math.abs(s.pingCostUsd - expectedCost) < 1e-12)
  assert.ok(Math.abs(s.balanceUsd - (expectedSaved - expectedCost)) < 1e-12)
})

test('formatReport: readable text, and an empty ledger says so', () => {
  assert.match(formatReport(summarize([], cfg)), /ledger is empty/)
  const text = formatReport(
    summarize([{ t: t(0), sessionId: 'a', event: 'skip', reason: 'cache-expired' }], cfg),
  )
  assert.match(text, /cache-expired\s+1/)
  assert.match(text, /balance\s+\+\$0\.00/)
})
