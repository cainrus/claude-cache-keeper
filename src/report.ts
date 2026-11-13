/**
 * `cache-keeper report`: what the ledger says the keeper did and whether it paid.
 *
 * The money is at API list prices (per-model rows in prices.ts, overridable in
 * config.json). On a subscription nothing is billed per token,
 * but the same tokens count against usage limits, so the ratio is still the
 * meaningful part.
 *
 * A resumed stretch is valued by what its first request really paid
 * (`resume-paid`): a full rewrite of the context, minus that payment. A resume
 * into a cache that had gone after all subtracts to about zero on its own. Only
 * a resume with no `resume-paid` (older ledgers, a transcript that never caught
 * up) falls back to the estimate from the context size.
 */

import type { Config } from './config.ts'
import { type LedgerEntry, REFUSAL_REASONS, type RefusalReason } from './ledger.ts'
import { type PriceTable, PRICES_AS_OF, promptOf, rateFor, requestUsd, rowFor } from './prices.ts'

export interface Summary {
  entries: number
  from?: string
  to?: string
  pings: number
  hits: number
  misses: number
  /** Pings whose wake turn was never scored (session ended, wake did not land). */
  unscored: number
  /** `/cache-keeper:ping`s: not scored, but their cost is in `pingCostUsd`. */
  manualPings: number
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
  /** Models with no price row (counted at `default`). */
  unpriced: string[]
  /** Hooks that threw (errors.ts), by hook. */
  errors: Record<string, number>
}

const tok = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Cost of one wake turn (or fork, or manual ping), USD. */
export function wakeCostUsd(e: LedgerEntry, prices: PriceTable): number {
  return requestUsd(e, rateFor(e.model, prices, promptOf(e)))
}

/** Estimate for a resumed-while-warm stretch: a full 1h rewrite of the context, minus the read it would pay instead. */
export function savedUsd(e: LedgerEntry, prices: PriceTable): number {
  const r = rateFor(e.model, prices, tok(e.ctxTokens))
  return (tok(e.ctxTokens) * (r.cacheWrite - r.cacheRead)) / 1e6
}

/** Measured: a full 1h rewrite of `ctxTokens`, minus what the resumed turn's first request paid. */
export function paidSavedUsd(ctxTokens: number, paid: LedgerEntry, prices: PriceTable): number {
  const r = rateFor(paid.model, prices, ctxTokens)
  const paidUsd = requestUsd({ inputTokens: paid.inputTokens, cacheRead: paid.cacheRead, cacheWrite: paid.cacheWrite }, r)
  return Math.max(0, (ctxTokens * r.cacheWrite) / 1e6 - paidUsd)
}

/** Models in the ledger that no price row names: counted at `default`, said in the report. */
export function unpricedModels(entries: LedgerEntry[], prices: PriceTable): string[] {
  const out = new Set<string>()
  for (const e of entries) if (e.model && rowFor(e.model, prices).key === 'default') out.add(e.model)
  return [...out].sort()
}

export function summarize(entries: LedgerEntry[], config: Pick<Config, 'prices' | 'cacheTtlSec' | 'hitRatio'>): Summary {
  const s: Summary = {
    entries: entries.length,
    from: entries[0]?.t,
    to: entries.at(-1)?.t,
    pings: 0,
    hits: 0,
    misses: 0,
    manualPings: 0,
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
    unpriced: unpricedModels(entries, config.prices),
    errors: {},
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
        s.pingCostUsd += wakeCostUsd(e, config.prices)
        // A handoff turn (detail 'handoff') writes a brief: it costs, but was no ping.
        if (e.detail === 'handoff') break
        if (e.event === 'wake-hit') s.hits++
        else s.misses++
        break
      case 'manual-ping':
        s.manualPings++
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
      case 'error': {
        const hook = (e.detail ?? '').split(':')[0] || 'unknown'
        s.errors[hook] = (s.errors[hook] ?? 0) + 1
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

/** What the report says about the per-stretch cap: fixed by the config, or where the tuner left it. */
export interface CapLine {
  maxPings: number
  auto: boolean
  why?: string
  step?: 'up' | 'down' | 'hold'
  from?: number
}

export function formatCap(c: CapLine): string {
  if (!c.auto) return `max pings per stretch  ${c.maxPings} (set in config)`
  if (!c.why) return `max pings per stretch  ${c.maxPings} (auto, not computed yet)`
  const move = c.step === 'hold' || c.from === undefined ? 'held' : `${c.step} from ${c.from}`
  return `max pings per stretch  ${c.maxPings} (auto, ${move}: ${c.why})`
}

export function formatReport(s: Summary, cap?: CapLine): string {
  if (s.entries === 0) return 'cache-keeper: the ledger is empty — no idle session has reached a decision yet.\n'
  const lines = [
    `cache-keeper report  ${s.from?.slice(0, 16)} .. ${s.to?.slice(0, 16)}  (${s.entries} ledger lines)`,
    '',
    'pings',
    row('sent', s.pings),
    row('cache hits', s.hits),
    row('cache misses', s.misses),
    row('not scored', s.unscored),
    ...(s.manualPings > 0 ? [row('pings by hand', s.manualPings)] : []),
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
    ...(Object.keys(s.errors).length > 0
      ? ['', 'hook errors (see errors.log)', ...Object.entries(s.errors).map(([hook, n]) => row(hook, n))]
      : []),
    '',
    s.measuredResumes > 0
      ? `at API list prices of ${PRICES_AS_OF} (measured where paid, estimated elsewhere)`
      : `estimate at API list prices of ${PRICES_AS_OF}`,
    ...(s.unpriced.length > 0 ? [`  no price for ${s.unpriced.join(', ')}: counted at "default" (set "prices" in config.json)`] : []),
    row('rewrites avoided', usd(s.savedUsd)),
    row('ping cost', usd(s.pingCostUsd)),
    row('balance', (s.balanceUsd >= 0 ? '+' : '') + usd(s.balanceUsd)),
    ...(cap ? ['', formatCap(cap)] : []),
  ]
  return `${lines.join('\n')}\n`
}
