/** How keeper writes times and token counts for people: the status report and the ping replies. */

/** Local wall-clock HH:MM, as the status line prints it. */
export function hhmm(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 58435 -> "58k": a context size at a glance. */
export function shortTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

/** 58435 -> "58,435": a measured count. */
export function groupedTokens(n: number): string {
  return n.toLocaleString('en-US')
}

/**
 * Why there is nothing to hold, worded once for `/cache-keeper:status` and
 * `/cache-keeper:ping`. Each finishes a sentence.
 */
export const NOTHING_TO_HOLD = {
  noTurn: 'no turn has ended in this session yet, so nothing is cached',
  expired: (warmUntil: number) => `the cache expired at ${hhmm(warmUntil)}; your next message rewrites it`,
  compacted: 'compacted since the last turn; the new context is cached by your next message',
} as const
