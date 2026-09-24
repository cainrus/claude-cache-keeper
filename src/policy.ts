/**
 * The keep-alive policy: should an idle session be pinged right now?
 *
 * Pure by construction — no clock, no disk, no environment. Everything it
 * needs arrives in `PolicyInput`, which is what makes it replayable over
 * recorded idle stretches and trivially testable.
 */

export interface Thresholds {
  /** Keyboard/mouse idle longer than this: the human is gone, let the cache go. */
  awaySec: number
  /**
   * Idle at most this long counts as "at the keyboard". Between `presenceSec`
   * and `awaySec` pings still go out, but they are paid from the machine-wide
   * away budget.
   */
  presenceSec: number
  /** Pings the whole machine may spend on one absence; refilled by presence. */
  maxAwayPings: number
  /** Contexts smaller than this are cheap to rebuild and not worth holding. */
  minCtxTokens: number
  /** Cache younger than this is still warm: nothing to do yet. */
  minAgeSec: number
  /**
   * Cache older than this may already be gone (1h TTL minus a margin for the
   * request to land); a ping would pay a full rewrite instead of a read.
   */
  maxAgeSec: number
  /** Pings per idle stretch of one session (reset only by a real prompt). */
  maxPings: number
}

export const THRESHOLDS: Readonly<Thresholds> = Object.freeze({
  awaySec: 1200,
  presenceSec: 300,
  maxAwayPings: 6,
  minCtxTokens: 20_000,
  minAgeSec: 50 * 60,
  maxAgeSec: 58 * 60,
  maxPings: 4,
})

export interface PolicyInput {
  /**
   * Seconds since the last keyboard/mouse event, or null when the probe could
   * not answer. null is deliberately NOT flattened to zero — see `decide`.
   */
  awaySeconds: number | null
  /** Seconds since the cache of this session was last touched (a real turn or a landed ping). */
  ageSec: number
  /** Size of the cached prefix, tokens. */
  ctxTokens: number
  /** Pings already spent on this idle stretch of this session. */
  pingsSoFar: number
  /** Pings spent by every session on this machine since presence was last seen. */
  awayPingsSincePresence: number
  /** Did the previous ping read the cache (true) or rewrite it (false)? null = no ping yet. */
  lastPingHit: boolean | null
}

/** Refusal reasons, in the order `decide` checks them. */
export const SKIP_REASONS = [
  'away',
  'away-budget-spent',
  'context-too-small',
  'cache-expired',
  'cache-still-warm',
  'budget-spent',
  'oracle-miss',
] as const

export type SkipReason = (typeof SKIP_REASONS)[number]

export type Decision = { ping: true } | { ping: false; reason: SkipReason }

/**
 * At the keyboard = the probe answered AND reported a short idle. An unknown
 * probe is *not* at the keyboard: that is what keeps the away budget — the
 * only machine-wide cap — in force while the probe is broken.
 */
export function isAtKeyboard(awaySeconds: number | null, t: Thresholds = THRESHOLDS): boolean {
  return awaySeconds !== null && awaySeconds <= t.presenceSec
}

/**
 * Branch order is the policy: it decides which reason the ledger blames.
 * Presence first (a machine nobody sits at needs no budget explanation), then
 * the facts about what a ping would cost, then the per-session limits.
 */
export function decide(s: PolicyInput, t: Thresholds = THRESHOLDS): Decision {
  // Unknown presence is not "gone": the away gate only fires on a real reading.
  // `null > n` would be false anyway, but spelled out so the intent is visible.
  const goneForGood = s.awaySeconds !== null && s.awaySeconds > t.awaySec
  if (goneForGood) return { ping: false, reason: 'away' }

  // While the human is at the keyboard the bucket is full by definition and is
  // not consulted. Otherwise — including an unreadable probe — it is.
  if (!isAtKeyboard(s.awaySeconds, t) && s.awayPingsSincePresence >= t.maxAwayPings) {
    return { ping: false, reason: 'away-budget-spent' }
  }

  if (s.ctxTokens < t.minCtxTokens) return { ping: false, reason: 'context-too-small' }
  // A dead cache outranks "still warm" and the budgets: it is a fact about
  // what the ping would cost, not a preference.
  if (s.ageSec >= t.maxAgeSec) return { ping: false, reason: 'cache-expired' }
  if (s.ageSec < t.minAgeSec) return { ping: false, reason: 'cache-still-warm' }
  if (s.pingsSoFar >= t.maxPings) return { ping: false, reason: 'budget-spent' }
  if (s.lastPingHit === false) return { ping: false, reason: 'oracle-miss' }
  return { ping: true }
}
