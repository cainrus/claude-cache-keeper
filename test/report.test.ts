import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PRICES } from '../src/config.ts'
import type { LedgerEntry } from '../src/ledger.ts'
import { mergePrices, rateFor, rowFor } from '../src/prices.ts'
import { formatReport, paidSavedUsd, savedUsd, summarize, unpricedModels, wakeCostUsd } from '../src/report.ts'

const cfg = { prices: DEFAULT_PRICES, cacheTtlSec: 3600, hitRatio: 0.9 }
const t = (m: number) => new Date(Date.UTC(2026, 0, 1, 10, m)).toISOString()

test('prices: the longest model prefix wins, an unknown model is default', () => {
  assert.equal(rowFor('claude-opus-5-5', DEFAULT_PRICES).key, 'claude-opus-5-5')
  assert.equal(rowFor('claude-opus-5-5[1m]', DEFAULT_PRICES).key, 'claude-opus-5-5')
  assert.equal(rowFor('claude-opus-5', DEFAULT_PRICES).key, 'claude-opus-5')
  assert.equal(rowFor('claude-opus-4-8', DEFAULT_PRICES).key, 'claude-opus-4')
  assert.equal(rowFor('claude-fable-5-2', DEFAULT_PRICES).key, 'claude-fable-5-2')
  assert.equal(rowFor('claude-sonnet-5-5', DEFAULT_PRICES).key, 'claude-sonnet-5-5')
  assert.equal(rowFor('claude-opus-9', DEFAULT_PRICES).key, 'default')
  assert.equal(rowFor(undefined, DEFAULT_PRICES).key, 'default')
  // Opus 5.5: $4 in, $0.20 read (0.05x), $8 1h write, $20 out.
  assert.deepEqual(rateFor('claude-opus-5-5', DEFAULT_PRICES), { input: 4, cacheRead: 0.2, cacheWrite: 8, output: 20 })
  assert.equal(rateFor('claude-sonnet-5-5', DEFAULT_PRICES).cacheRead, 0.1)
  // Haiku 5.5 is dearer past a 100K prompt.
  assert.equal(rateFor('claude-haiku-5-5', DEFAULT_PRICES, 50_000).input, 0.1)
  assert.equal(rateFor('claude-haiku-5-5', DEFAULT_PRICES, 150_000).input, 0.5)
})

test('prices: config.json overrides, in the old number form and as objects', () => {
  const p = mergePrices({ 'claude-opus-5-5': { cacheRead: 0.3 }, opus: 15, 'claude-new-1': { input: 2, output: 7 }, bad: 'x', neg: -1 })
  // "opus" (the old form) sets every Opus row; a model key, listed in any order, goes on top of it.
  assert.equal(rowFor('claude-opus-4-8', p).rate.input, 15)
  assert.equal(rowFor('claude-opus-5-5', p).rate.input, 15)
  assert.equal(rowFor('claude-opus-5-5', p).rate.cacheRead, 0.3)
  assert.equal(rowFor('claude-sonnet-5-5', p).rate.input, 2, 'other families keep the table')
  assert.equal(mergePrices({ 'claude-opus-5-5': { output: 30 } })['claude-opus-5-5'].cacheRead, 0.2, 'fields left out keep the table row')
  assert.equal(rowFor('claude-new-1', p).rate.output, 7)
  assert.equal(rowFor('claude-new-1', p).rate.cacheWrite, 4)
  assert.equal(rowFor('my-opus-proxy', p).key, 'opus')
  assert.equal(p.bad, undefined)
  assert.equal(p.neg, undefined)
})

test('wake cost and saved rewrite use the model row', () => {
  const wakeLine: LedgerEntry = {
    t: t(0), sessionId: 'a', event: 'wake-hit', model: 'claude-opus-5-5',
    inputTokens: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, outputTokens: 1_000_000,
  }
  assert.equal(wakeCostUsd(wakeLine, DEFAULT_PRICES), 4 + 0.2 + 8 + 20)
  const resume: LedgerEntry = { t: t(0), sessionId: 'a', event: 'resume', ctxTokens: 200_000, model: 'claude-opus-5-5' }
  assert.ok(Math.abs(savedUsd(resume, DEFAULT_PRICES) - 0.2 * (8 - 0.2)) < 1e-9)
  // A model the table does not know is named, and counted at default.
  assert.deepEqual(unpricedModels([wakeLine, { ...resume, model: 'claude-opus-9' }], DEFAULT_PRICES), ['claude-opus-9'])
  assert.match(formatReport(summarize([{ ...wakeLine, model: 'claude-opus-9' }], cfg)), /no price for claude-opus-9/)
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

test('summarize: a measured resume replaces the estimate; a cold one is worth nothing', () => {
  const opus = 'claude-opus-4-5'
  const resume = (sid: string, m: number): LedgerEntry =>
    ({ t: t(m), sessionId: sid, event: 'resume', pings: 1, lastPingHit: true, ageSec: 600, ctxTokens: 100_000, model: opus })
  const L: LedgerEntry[] = [
    // a: the held prefix was read back
    { t: t(0), sessionId: 'a', event: 'ping' },
    resume('a', 1),
    { t: t(2), sessionId: 'a', event: 'resume-paid', model: opus, inputTokens: 10, cacheRead: 99_000, cacheWrite: 1_000 },
    // b: estimated as saved, but the first request rewrote everything
    { t: t(3), sessionId: 'b', event: 'ping' },
    resume('b', 4),
    { t: t(5), sessionId: 'b', event: 'resume-paid', model: opus, inputTokens: 10, cacheRead: 0, cacheWrite: 100_000 },
    // c: no resume-paid (older ledger): the estimate stands
    { t: t(6), sessionId: 'c', event: 'ping' },
    resume('c', 7),
    // a stray resume-paid without a pinged resume is ignored
    { t: t(8), sessionId: 'd', event: 'resume-paid', model: opus, cacheRead: 5, cacheWrite: 5 },
  ]
  const s = summarize(L, cfg)
  assert.equal(s.resumedAfterPing, 3)
  assert.equal(s.savedRewrites, 3)
  assert.equal(s.measuredResumes, 2)
  assert.equal(s.heldNotUsed, 1)
  const expected = paidSavedUsd(100_000, L[2], DEFAULT_PRICES) + paidSavedUsd(100_000, L[5], DEFAULT_PRICES) + savedUsd(L[7], DEFAULT_PRICES)
  assert.ok(Math.abs(s.savedUsd - expected) < 1e-12)
  assert.ok(paidSavedUsd(100_000, L[2], DEFAULT_PRICES) > 0)
  assert.ok(paidSavedUsd(100_000, L[5], DEFAULT_PRICES) < 0.001)
  assert.match(formatReport(s), /held, not used\s+1/)
  assert.match(formatReport(s), /measured where paid/)
})

test('formatReport: readable text, and an empty ledger says so', () => {
  assert.match(formatReport(summarize([], cfg)), /ledger is empty/)
  const text = formatReport(
    summarize([{ t: t(0), sessionId: 'a', event: 'skip', reason: 'cache-expired' }], cfg),
  )
  assert.match(text, /cache-expired\s+1/)
  assert.match(text, /balance\s+\+\$0\.00/)
})
