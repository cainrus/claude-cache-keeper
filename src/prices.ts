/**
 * API list prices, USD per million tokens, per model.
 *
 * No Anthropic endpoint returns prices (the Models API gives ids, limits and
 * capabilities only), and keeper makes no network calls, so the table is kept
 * here by hand, dated, and `prices` in config.json overrides any row. A model
 * the table does not know is counted at `default` and named in the report.
 *
 * The cache-read ratio differs by model since the 5.x line: 0.1x of input on
 * most, 0.05x on Opus 5.5 and Sonnet 5.5, 0.025x on Fable / Mythos 5.1 and 5.2.
 * A 1-hour cache write is 2x input everywhere, output 5x.
 */

export interface Rate {
  input: number
  cacheRead: number
  /** 1-hour TTL write: keeper's case. */
  cacheWrite: number
  output: number
  /** Claude Haiku 5.5 bills a prompt over 100K tokens at a higher rate. */
  over100k?: Rate
}

export type PriceTable = Record<string, Rate>

/** When the rows below were checked. */
export const PRICES_AS_OF = '2026-11-03'

/** A row from the input price and the cache-read price, with the standard write and output multiples. */
export function rate(input: number, cacheRead = input * 0.1, extra: Partial<Rate> = {}): Rate {
  return { input, cacheRead, cacheWrite: input * 2, output: input * 5, ...extra }
}

/** Keys are model id prefixes; the longest one that matches wins. */
export const DEFAULT_PRICES: PriceTable = {
  'claude-fable-5-2': rate(8, 0.2),
  'claude-mythos-5-2': rate(8, 0.2),
  'claude-fable-5-1': rate(10, 0.25),
  'claude-mythos-5-1': rate(10, 0.25),
  'claude-fable-5': rate(10, 1),
  'claude-mythos-5': rate(10, 1),
  'claude-opus-5-5': rate(4, 0.2),
  'claude-opus-5': rate(5),
  'claude-opus-4': rate(5),
  'claude-sonnet-5-5': rate(2, 0.1),
  'claude-sonnet-5': rate(2),
  'claude-sonnet-4': rate(3),
  'claude-haiku-5-5': rate(0.1, undefined, { over100k: rate(0.5) }),
  'claude-haiku-4': rate(1),
  // Ids older than the 4 line, still in old ledgers.
  'claude-3-opus': rate(15),
  'claude-3-7-sonnet': rate(3),
  'claude-3-5-sonnet': rate(3),
  'claude-3-5-haiku': rate(0.8),
  'claude-3-haiku': rate(0.25),
  default: rate(5),
}

/** Bedrock and Vertex spell ids with a provider prefix (`us.anthropic.claude-…`, `anthropic.claude-…`). */
function bareId(model: string): string {
  const m = model.toLowerCase()
  const at = m.indexOf('claude-')
  return at > 0 ? m.slice(at) : m
}

/**
 * Prices in force: config.json's `prices` over the table. A row there is either
 * a number (the input price, standard multiples; the pre-0.6.6 form, keyed by
 * any part of the model id such as "opus") or an object with any of the fields.
 */
export function mergePrices(overrides: unknown): PriceTable {
  const out: PriceTable = { ...DEFAULT_PRICES }
  if (!overrides || typeof overrides !== 'object') return out
  const pos = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
  const row = (key: string, v: unknown): Rate | undefined => {
    const n = pos(v)
    if (n !== undefined) return rate(n)
    if (!v || typeof v !== 'object') return undefined
    const o = v as Record<string, unknown>
    const base = out[key]
    const input = pos(o.input) ?? base?.input
    if (input === undefined) return undefined
    const keep = pos(o.input) === undefined ? base : undefined
    return {
      input,
      cacheRead: pos(o.cacheRead) ?? keep?.cacheRead ?? input * 0.1,
      cacheWrite: pos(o.cacheWrite) ?? keep?.cacheWrite ?? input * 2,
      output: pos(o.output) ?? keep?.output ?? input * 5,
      // An overridden row is the person's price at every prompt size: the table's long-prompt tier goes.
    }
  }
  // A family key ("opus", the pre-0.6.6 form) rewrites every table row it names; model prefixes after it.
  const entries = Object.entries(overrides as Record<string, unknown>)
  const isFamily = (k: string) => k !== 'default' && !k.startsWith('claude-')
  for (const [key, v] of [...entries.filter(([k]) => isFamily(k)), ...entries.filter(([k]) => !isFamily(k))]) {
    const r = row(key, v)
    if (r === undefined) continue
    out[key] = r
    if (isFamily(key)) for (const k of Object.keys(DEFAULT_PRICES)) if (k.includes(key.toLowerCase())) out[k] = r
  }
  return out
}

/** The row for a model: the longest key that prefixes its id, else one it contains (an override like "opus"), else default. */
export function rowFor(model: string | undefined, prices: PriceTable): { key: string; rate: Rate } {
  const full = (model ?? '').toLowerCase()
  const m = bareId(full)
  let best: string | undefined
  for (const key of Object.keys(prices)) {
    if (key === 'default') continue
    const k = key.toLowerCase()
    if ((m.startsWith(k) || full.startsWith(k)) && (best === undefined || k.length > best.length)) best = key
  }
  if (best === undefined) {
    best = Object.keys(prices).find((key) => key !== 'default' && !key.startsWith('claude-') && m.includes(key.toLowerCase()))
  }
  return best === undefined ? { key: 'default', rate: prices.default ?? rate(5) } : { key: best, rate: prices[best] }
}

/** The rate a request with `promptTokens` of prompt pays. */
export function rateFor(model: string | undefined, prices: PriceTable, promptTokens = 0): Rate {
  const r = rowFor(model, prices).rate
  return promptTokens > 100_000 && r.over100k ? r.over100k : r
}

/** Token counts as the ledger keeps them. */
export interface Usage {
  inputTokens?: number
  cacheRead?: number
  cacheWrite?: number
  outputTokens?: number
}

const tok = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** What one request cost, USD. */
export function requestUsd(u: Usage, r: Rate): number {
  return (tok(u.inputTokens) * r.input + tok(u.cacheRead) * r.cacheRead + tok(u.cacheWrite) * r.cacheWrite + tok(u.outputTokens) * r.output) / 1e6
}

/** Prompt size of a request, for the over-100K rate. */
export function promptOf(u: Usage): number {
  return tok(u.inputTokens) + tok(u.cacheRead) + tok(u.cacheWrite)
}
