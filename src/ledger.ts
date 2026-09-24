/**
 * Append-only decision log, `$CACHE_KEEPER_HOME/ledger.jsonl`.
 *
 * Lines are small and appended with O_APPEND, so concurrent hooks interleave
 * whole lines. Readers skip anything that does not parse.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SkipReason } from './policy.ts'

export type LedgerEvent = 'ping' | 'skip' | 'resume' | 'wake-hit' | 'wake-miss'

export interface LedgerEntry {
  /** ISO timestamp. */
  t: string
  sessionId: string
  event: LedgerEvent
  reason?: SkipReason
  ctxTokens?: number
  ageSec?: number
  model?: string
  /** resume: pings spent on the stretch that just ended. */
  pings?: number
  /** resume: whether the last ping of the stretch hit the cache (null = unknown). */
  lastPingHit?: boolean | null
  /** wake-hit / wake-miss: the wake turn's own usage. */
  inputTokens?: number
  cacheRead?: number
  cacheWrite?: number
  outputTokens?: number
  /** ping / skip: keyboard idle seconds (null = unknown). */
  awaySeconds?: number | null
}

export function ledgerPath(home: string): string {
  return join(home, 'ledger.jsonl')
}

export function appendLedger(home: string, entry: LedgerEntry): void {
  mkdirSync(home, { recursive: true })
  appendFileSync(ledgerPath(home), `${JSON.stringify(entry)}\n`)
}

export function parseLedger(text: string): LedgerEntry[] {
  const out: LedgerEntry[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const e = JSON.parse(line)
      if (e && typeof e.event === 'string' && typeof e.sessionId === 'string') out.push(e)
    } catch {
      // a torn or foreign line: skip it
    }
  }
  return out
}

export function readLedger(home: string): LedgerEntry[] {
  try {
    return parseLedger(readFileSync(ledgerPath(home), 'utf8'))
  } catch {
    return []
  }
}
