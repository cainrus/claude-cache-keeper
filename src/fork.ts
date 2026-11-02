/**
 * Pings as `$.model.fork`, sent by the plugin's mod (hooks/keepalive.ts).
 *
 * A fork replays the main thread's last request with one question after it,
 * so the API serves the prefix from the cache and renews it, while nothing is
 * added to the transcript. Measured on Claude Code 2.1.316: right after a turn
 * a fork read the whole 54k prefix and wrote only the 3k uncached tail; a
 * second fork wrote 0. The mod owns the timer; these subcommands own every
 * decision, so the policy, budgets, tuning and ledger stay the ones `wake` uses:
 *
 *   arm            the mod took the session (a turn ended, or the mod reloaded)
 *   fork-wake      the mod's timer fired: none, a fork, or a turn (a handoff)
 *   forked         the fork's result: score it, or fall back to a wake turn
 *   compact-check  a compaction is about to run (anthropics/claude-code#105017)
 *
 * Each reads the hook-style JSON on stdin and answers one JSON line on stdout.
 * Without the mod (an older Claude Code, mods off) none of them runs, nothing
 * writes the claim (`forks/<id>.json`), and the Stop sleeper pings with a wake
 * turn as before. `CACHE_KEEPER_FORK=0` or `"forkPings": false` does the same.
 */

import { decideWake, forkOwns, WAKE_MARKER, WAKE_MESSAGE, type Ctx, type HookInput } from './commands.ts'
import { appendLedger } from './ledger.ts'
import { loadSession, saveForkClaim, saveSession } from './state.ts'

export const FORK_PROMPT = `${WAKE_MARKER} Reply with exactly "ok".`

/** What the mod hands `forked`: `$.model.fork`'s result, as it came back. */
export interface ForkResult {
  isAnswered: boolean
  reason?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

export interface ForkInput extends HookInput {
  /** arm: the mod reloaded mid-stretch, so time the next ping from the last turn. */
  reload?: boolean
  /** forked */
  fork?: ForkResult
  /** compact-check: `session.compact`'s trigger. */
  trigger?: string
}

export type ForkAnswer =
  | { action: 'none'; dueInSec?: number }
  | { action: 'fork'; prompt: string }
  | { action: 'turn'; text: string }
  | { action: 'pass' }
  | { action: 'renew'; text: string }

const iso = (ms: number) => new Date(ms).toISOString()
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function answer(ctx: Ctx, a: ForkAnswer): number {
  ctx.stdout?.(`${JSON.stringify(a)}\n`)
  return 0
}

/**
 * The mod takes this session's pings. After a turn the next ping is due one
 * full delay later; after a reload, what is left of it. `claude -p` is skipped,
 * as the Stop sleeper skips it: the process ends with the turn.
 */
export function arm(input: ForkInput, ctx: Ctx, env: NodeJS.ProcessEnv = process.env): number {
  const sid = input.session_id
  const { home, enabled, forkPings, delaySec, thresholds } = ctx.config
  if (!sid || !enabled || !forkPings || env.CLAUDE_CODE_ENTRYPOINT === 'sdk-cli') return answer(ctx, { action: 'none' })
  const state = loadSession(home, sid)
  if (!state) return answer(ctx, { action: 'none' })
  if (!input.reload) {
    saveForkClaim(home, sid, ctx.now)
    return answer(ctx, { action: 'none', dueInSec: delaySec })
  }
  // A reload: what is left of the stretch, if anything. A resumed old session has none.
  if (state.lastTurnEndAt === undefined) return answer(ctx, { action: 'none' })
  const age = Math.floor((ctx.now - state.lastTurnEndAt) / 1000)
  if (age >= thresholds.maxAgeSec) return answer(ctx, { action: 'none' })
  saveForkClaim(home, sid, ctx.now)
  // A fork in flight did not survive the reload: nothing will score it.
  if (state.pendingPing && state.pingTransport === 'fork') {
    state.pendingPing = false
    saveSession(home, state)
  }
  return answer(ctx, { action: 'none', dueInSec: Math.max(1, delaySec - age) })
}

/** The mod's timer fired: the same decision as the Stop sleeper's `wake`, delivered as JSON. */
export function forkWake(input: ForkInput, ctx: Ctx): number {
  const state = input.session_id ? loadSession(ctx.config.home, input.session_id) : undefined
  // The claim failed at the last turn's end (a CLI that did not answer): the Stop sleeper pings this one.
  if (!state || !forkOwns(state, ctx.config)) return answer(ctx, { action: 'none' })
  const out = decideWake(input, ctx, 'fork')
  if (out.kind === 'ping') return answer(ctx, { action: 'fork', prompt: FORK_PROMPT })
  if (out.kind === 'handoff') return answer(ctx, { action: 'turn', text: out.message })
  return answer(ctx, out.retryInSec !== undefined ? { action: 'none', dueInSec: out.retryInSec } : { action: 'none' })
}

/**
 * Score the fork like `record` scores a wake turn. A fork that brought no
 * reply falls back to the wake turn, so a ping the policy granted still goes out.
 */
export function forked(input: ForkInput, ctx: Ctx): number {
  const sid = input.session_id
  const { home, hitRatio, delaySec } = ctx.config
  if (!sid) return answer(ctx, { action: 'none' })
  const state = loadSession(home, sid)
  if (!state || !state.pendingPing || state.pingTransport !== 'fork') return answer(ctx, { action: 'none' })
  const f = input.fork
  const base = { t: iso(ctx.now), sessionId: sid, ctxTokens: state.ctxTokens, model: state.model }

  if (!f?.isAnswered || !f.usage) {
    state.pingTransport = 'turn'
    state.lastPingAt = ctx.now
    saveSession(home, state)
    appendLedger(home, { ...base, event: 'fork-failed', failure: f?.reason ?? 'no-result' })
    return answer(ctx, { action: 'turn', text: WAKE_MESSAGE })
  }

  const cacheRead = n(f.usage.cache_read_input_tokens)
  const cacheWrite = n(f.usage.cache_creation_input_tokens)
  const denom = cacheRead + cacheWrite
  const hit = denom > 0 && cacheRead / denom >= hitRatio
  state.pendingPing = false
  state.lastPingHit = hit
  // The read renewed the cache now: the next ping is timed from here.
  state.lastTurnEndAt = ctx.now
  state.forkPingsHeld = (state.forkPingsHeld ?? 0) + 1
  saveSession(home, state)
  saveForkClaim(home, sid, ctx.now)
  appendLedger(home, {
    ...base,
    event: hit ? 'wake-hit' : 'wake-miss',
    transport: 'fork',
    inputTokens: n(f.usage.input_tokens),
    cacheRead,
    cacheWrite,
    outputTokens: n(f.usage.output_tokens),
  })
  return answer(ctx, { action: 'none', dueInSec: delaySec })
}

/** Leeway under the TTL: Claude Code's own check may run on a slightly different clock. */
const TTL_MARGIN_MS = 60_000

/**
 * anthropics/claude-code#105017: a fork renews the server's cache but not
 * Claude Code's own clock. A compaction that finds no main-thread request
 * within the TTL drops its cache markers and sends the whole context
 * uncached, though forks kept it warm. So when forks alone held this stretch
 * past the TTL, one wake turn goes first (it is a request Claude Code sees,
 * and it reads the warm cache), and the compaction runs after it.
 */
export function compactCheck(input: ForkInput, ctx: Ctx): number {
  const sid = input.session_id
  const { home, cacheTtlSec } = ctx.config
  if (!sid || (input.trigger !== 'manual' && input.trigger !== 'plugin')) return answer(ctx, { action: 'pass' })
  const state = loadSession(home, sid)
  if (!state || !state.forkPingsHeld || state.lastRequestAt === undefined || state.lastTurnEndAt === undefined) {
    return answer(ctx, { action: 'pass' })
  }
  const ttl = cacheTtlSec * 1000
  const engineThinksCold = ctx.now - state.lastRequestAt >= ttl - TTL_MARGIN_MS
  const warm = ctx.now - state.lastTurnEndAt < ttl
  if (!engineThinksCold || !warm) return answer(ctx, { action: 'pass' })
  appendLedger(home, {
    t: iso(ctx.now),
    sessionId: sid,
    event: 'renew',
    ctxTokens: state.ctxTokens,
    model: state.model,
    ageSec: Math.floor((ctx.now - state.lastRequestAt) / 1000),
    pings: state.forkPingsHeld,
  })
  return answer(ctx, { action: 'renew', text: WAKE_MESSAGE })
}
