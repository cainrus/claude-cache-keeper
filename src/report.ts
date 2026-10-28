/**
 * `cache-keeper report`: what the ledger says the keeper did and whether it paid.
 *
 * The money is at API list prices (per-model base input price from the config,
 * standard multipliers below). On a subscription nothing is billed per token,
 * but the same tokens count against usage limits, so the ratio is still the
 * meaningful part.
 *
 * A resumed stretch is valued by what its first request really paid
 * (`resume-paid`): a full rewrite of the context, minus that payment. A resume
 * into a cache that had gone after all subtracts to about zero on its own. Only
 * a resume with no `resume-paid` (older ledgers, a transcript that never caught
 * up) falls back to the estimate from the context size.
 */

import type { Config, PriceTable } from './config.ts'
import { type LedgerEntry, REFUSAL_REASONS, type RefusalReason } from './ledger.ts'

/** Multipliers of the base input price. */
export const MULT = {
  input: 1,
  cacheRead: 0.1,
  /** 1-hour TTL cache write. */
  cacheWrite: 2,
  output: 5,
} as const

export interface Summary {
  entries: number
  from?: string
  to?: string
  pings: number
  hits: number
  misses: number
  /** Pings whose wake turn was never scored (session ended, wake did not land). */
  unscored: number
  /** Idle stretches that had >= 1 ping and ended with a real prompt. */
  resumedAfterPing: number
  /** ...of those, the ones that came back while the held cache was still alive. */
  savedRewrites: number
  /** Idle stretches that had >= 1 ping and no real prompt afterwards (yet). */
  abandoned: number
  /** Resumes after a ping whose first request was measured (`resume-paid`). */
  measuredResumes: number
  /** ...of those, the ones whose first request rewrote the prefix anyway: the pings bought nothing. */
  heldNotUsed: number
  refusals: Partial<Record<RefusalReason, number>>
  refusalsTotal: number
  savedUsd: number
  pingCostUsd: number
  balanceUsd: number
}

export function basePrice(model: string | undefined, prices: PriceTable): number {
  const m = (model ?? '').toLowerCase()
  for (const [key, price] of Object.entries(prices)) {
    if (key !== 'default' && m.includes(key.toLowerCase())) return price
  }
  return prices.default ?? 5
}

const tok = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Cost of one wake turn, USD. */
export function wakeCostUsd(e: LedgerEntry, prices: PriceTable): number {
  const units =
    tok(e.inputTokens) * MULT.input +
    tok(e.cacheRead) * MULT.cacheRead +
    tok(e.cacheWrite) * MULT.cacheWrite +
    tok(e.outputTokens) * MULT.output
  return (units * basePrice(e.model, prices)) / 1e6
}

/** Estimate for a resumed-while-warm stretch: a full 1h rewrite of the context, minus the read it would pay instead. */
export function savedUsd(e: LedgerEntry, prices: PriceTable): number {
  return (tok(e.ctxTokens) * (MULT.cacheWrite - MULT.cacheRead) * basePrice(e.model, prices)) / 1e6
}

/** Measured: a full 1h rewrite of `ctxTokens`, minus what the resumed turn's first request paid. */
export function paidSavedUsd(ctxTokens: number, paid: LedgerEntry, prices: PriceTable): number {
  const paidUnits = tok(paid.inputTokens) * MULT.input + tok(paid.cacheRead) * MULT.cacheRead + tok(paid.cacheWrite) * MULT.cacheWrite
  return (Math.max(0, ctxTokens * MULT.cacheWrite - paidUnits) * basePrice(paid.model, prices)) / 1e6
}

export function summarize(entries: LedgerEntry[], config: Pick<Config, 'prices' | 'cacheTtlSec' | 'hitRatio'>): Summary {
  const s: Summary = {
    entries: entries.length,
    from: entries[0]?.t,
    to: entries.at(-1)?.t,
    pings: 0,
    hits: 0,
    misses: 0,
    unscored: 0,
    resumedAfterPing: 0,
    savedRewrites: 0,
    abandoned: 0,
    measuredResumes: 0,
    heldNotUsed: 0,
    refusals: {},
    refusalsTotal: 0,
    savedUsd: 0,
    pingCostUsd: 0,
    balanceUsd: 0,
  }
  /** Pings in the currently open idle stretch, per session. */
  const open = new Map<string, number>()
  /** A pinged resume waiting for its `resume-paid`: the context it held and the estimate already counted. */
  const awaitingPaid = new Map<string, { ctxTokens: number; estimateUsd: number }>()

  for (const e of entries) {
    switch (e.event) {
      case 'ping':
        s.pings++
        open.set(e.sessionId, (open.get(e.sessionId) ?? 0) + 1)
        break
      case 'wake-hit':
      case 'wake-miss':
        if (e.event === 'wake-hit') s.hits++
        else s.misses++
        s.pingCostUsd += wakeCostUsd(e, config.prices)
        break
      case 'resume':
        open.delete(e.sessionId)
        awaitingPaid.delete(e.sessionId)
        if (tok(e.pings) > 0) {
          s.resumedAfterPing++
          const warm = typeof e.ageSec === 'number' && e.ageSec < config.cacheTtlSec
          let estimateUsd = 0
          if (warm && e.lastPingHit !== false) {
            s.savedRewrites++
            estimateUsd = savedUsd(e, config.prices)
            s.savedUsd += estimateUsd
          }
          awaitingPaid.set(e.sessionId, { ctxTokens: tok(e.ctxTokens), estimateUsd })
        }
        break
      case 'resume-paid': {
        const pending = awaitingPaid.get(e.sessionId)
        if (!pending) break
        awaitingPaid.delete(e.sessionId)
        s.measuredResumes++
        const denom = tok(e.cacheRead) + tok(e.cacheWrite)
        if (denom === 0 || tok(e.cacheRead) / denom < config.hitRatio) s.heldNotUsed++
        s.savedUsd += paidSavedUsd(pending.ctxTokens, e, config.prices) - pending.estimateUsd
        break
      }
      case 'skip':
        if (e.reason) {
          s.refusals[e.reason] = (s.refusals[e.reason] ?? 0) + 1
          s.refusalsTotal++
        }
        break
    }
  }
  for (const n of open.values()) if (n > 0) s.abandoned++
  s.unscored = Math.max(0, s.pings - s.hits - s.misses)
  s.balanceUsd = s.savedUsd - s.pingCostUsd
  return s
}

const usd = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`
const row = (label: string, value: string | number) => `  ${label.padEnd(22)}${String(value).padStart(10)}`

export function formatReport(s: Summary): string {
  if (s.entries === 0) return 'cache-keeper: the ledger is empty — no idle session has reached a decision yet.\n'
  const lines = [
    `cache-keeper report  ${s.from?.slice(0, 16)} .. ${s.to?.slice(0, 16)}  (${s.entries} ledger lines)`,
    '',
    'pings',
    row('sent', s.pings),
    row('cache hits', s.hits),
    row('cache misses', s.misses),
    row('not scored', s.unscored),
    '',
    'idle stretches with a ping',
    row('resumed', s.resumedAfterPing),
    row('  while still warm', s.savedRewrites),
    row('  paid turn measured', s.measuredResumes),
    row('  held, not used', s.heldNotUsed),
    row('abandoned', s.abandoned),
    '',
    `refusals${' '.repeat(16)}${String(s.refusalsTotal).padStart(10)}`,
    ...REFUSAL_REASONS.filter((r) => s.refusals[r]).map((r) => row(r, s.refusals[r] as number)),
    '',
    s.measuredResumes > 0 ? 'at API list prices (measured where paid, estimated elsewhere)' : 'estimate at API list prices',
    row('rewrites avoided', usd(s.savedUsd)),
    row('ping cost', usd(s.pingCostUsd)),
    row('balance', (s.balanceUsd >= 0 ? '+' : '') + usd(s.balanceUsd)),
  ]
  return `${lines.join('\n')}\n`
}
