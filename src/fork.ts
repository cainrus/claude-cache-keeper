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
 *   forked         the fork's result: score it, send it again, fall back to a wake turn, or drop it
 *   fork-retry     the retry timer fired: the fork again, or nothing
 *   compact-check  a compaction is about to run (anthropics/claude-code#105017)
 *   compacted      a compaction finished: no pings until the next turn
 *   ping-now       `/cache-keeper:ping` reached the mod: a fork, a refusal, or `pass`
 *                  (forks off: the command's own turn is the ping)
 *
 * Each reads the hook-style JSON on stdin and answers one JSON line on stdout.
 * Without the mod (an older Claude Code, mods off) none of them runs, nothing
 * writes the claim (`forks/<id>.json`), and the Stop sleeper pings with a wake
 * turn as before. `CACHE_KEEPER_FORK=0` or `"forkPings": false` does the same.
 */

import { decideWake, PING_IN_FLIGHT_MS, WAKE_MARKER, WAKE_MESSAGE, type Ctx, type HookInput } from './commands.ts'
import { groupedTokens, hhmm, NOTHING_TO_HOLD } from './format.ts'
import { appendLedger } from './ledger.ts'
import { closePing, compactedSinceRequest, forkOwns, loadSession, saveForkClaim, saveSession, warmUntilOf } from './state.ts'

// Not WAKE_REPLY: a fork's answer never reaches the transcript, so nobody reads it as the session's last word.
// A turn sent instead of a fork (fallback, renew) does reach it, and carries WAKE_MESSAGE.
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
  | { action: 'none'; dueInSec?: number; text?: string }
  | { action: 'fork'; prompt: string }
  | { action: 'turn'; text: string }
  | { action: 'pass' }
  | { action: 'renew'; text: string }
  | { action: 'retry'; afterSec: number }

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
    closePing(state)
    // Nor will the turn that fork answered end in a Stop the mark could wait for.
    delete state.gateTurnAt
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
  // decideWake starts no handoff while a question waits (a handoff is a turn).
  if (out.kind === 'handoff') return answer(ctx, { action: 'turn', text: out.message })
  return answer(ctx, out.retryInSec !== undefined ? { action: 'none', dueInSec: out.retryInSec } : { action: 'none' })
}

/** The mod saw a compaction finish (not a precompute, not a skipped one); see `decideWake`. */
export function compacted(input: ForkInput, ctx: Ctx): number {
  const sid = input.session_id
  const state = sid ? loadSession(ctx.config.home, sid) : undefined
  if (state) {
    state.compactedAt = ctx.now
    saveSession(ctx.config.home, state)
  }
  return answer(ctx, { action: 'none' })
}

/**
 * The same, from the `SessionStart` hook Claude Code runs after a compaction
 * (source `compact`; bin/cache-keeper.sh calls node only then), so a session
 * without the mod learns of it too: the Stop sleeper armed before `/compact`
 * would otherwise ping the old, larger context into a cache that holds none of
 * the new one (#3709). Prints nothing: a SessionStart hook's stdout reaches the model.
 */
export function compactedStart(input: HookInput, ctx: Ctx): number {
  const sid = input.session_id
  const state = sid ? loadSession(ctx.config.home, sid) : undefined
  if (state && (state.compactedAt === undefined || state.compactedAt < ctx.now)) {
    state.compactedAt = ctx.now
    saveSession(ctx.config.home, state)
  }
  return 0
}

/**
 * The mod saw the main thread stop at AskUserQuestion. The turn stays open
 * until the person answers, so no Stop records it, no sleeper is armed, and an
 * answer that came an hour later used to rewrite the whole context (#3683:
 * 8 such rewrites in a week, the longest wait 45 h). The request that asked has
 * just renewed the cache, so the stretch starts now, and fork pings hold it as
 * after a turn's end, under the same policy. Wake turns never: a prompt sent
 * into the open turn would land inside it.
 */
export function waitStart(input: ForkInput, ctx: Ctx, env: NodeJS.ProcessEnv = process.env): number {
  const sid = input.session_id
  const { home, enabled, forkPings, delaySec } = ctx.config
  if (!sid || !enabled || !forkPings || env.CLAUDE_CODE_ENTRYPOINT === 'sdk-cli') return answer(ctx, { action: 'none' })
  const state = loadSession(home, sid)
  if (!state || state.lastTurnEndAt === undefined) return answer(ctx, { action: 'none' })
  state.lastTurnEndAt = ctx.now
  state.lastRequestAt = ctx.now
  state.forkPingsHeld = 0
  state.waitingSince = ctx.now
  saveSession(home, state)
  saveForkClaim(home, sid, ctx.now)
  return answer(ctx, { action: 'none', dueInSec: delaySec })
}

/**
 * The question was answered (or the call ended otherwise): the person is back,
 * as with a real prompt. A pinged wait is logged as a `resume`, so the report
 * counts what it saved, and the stretch's pings start over.
 */
export function waitEnd(input: ForkInput, ctx: Ctx): number {
  const sid = input.session_id
  const state = sid ? loadSession(ctx.config.home, sid) : undefined
  if (!sid || !state || state.waitingSince === undefined) return answer(ctx, { action: 'none' })
  if (state.pingsSoFar > 0) {
    appendLedger(ctx.config.home, {
      t: iso(ctx.now),
      sessionId: sid,
      event: 'resume',
      detail: 'question',
      pings: state.pingsSoFar,
      lastPingHit: state.lastPingHit,
      ctxTokens: state.ctxTokens,
      model: state.model,
      ageSec: cacheAgeSec(state, ctx.now),
    })
    state.resumeAt = ctx.now
  }
  // A fork waiting on its retry timer: the mod dropped that timer with the wait, so nothing would close it.
  // A fork still in flight is left to `forked`, which scores it and sends nothing after it.
  if (state.pendingPing && state.pingTransport === 'fork' && state.forkRetryParked) closePing(state)
  state.pingsSoFar = 0
  state.lastHumanAt = ctx.now
  delete state.waitingSince
  saveSession(ctx.config.home, state)
  return answer(ctx, { action: 'none' })
}

/** Forks re-sent for one ping before it falls back to the wake turn. */
export const MAX_FORK_RETRIES = 2
/** Pause before a re-sent fork: a failure is mostly the network or the API, rarely gone at once. */
export const FORK_RETRY_SEC = 60
/** The mod's own limit on one fork (hooks/keepalive.ts, FORK_TIMEOUT_MS). */
export const FORK_TIMEOUT_SEC = 120
/** Failures a second fork cannot fix. */
const FINAL_FORK_FAILURES = new Set(['nothing-to-fork'])

/** Seconds since the cache was last read or written. */
function cacheAgeSec(state: { lastTurnEndAt?: number }, now: number): number {
  return Math.floor((now - (state.lastTurnEndAt ?? 0)) / 1000)
}

/**
 * Score the fork like `record` scores a wake turn. A fork that brought no
 * reply is sent again while a re-sent one can still land under `maxAgeSec`,
 * then falls back to the wake turn. Past `maxAgeSec` nothing goes out: a
 * request that late finds the cache gone and writes the whole prefix, which
 * the person's own next turn pays anyway (measured: a fallback turn delayed by
 * a network outage landed 13 min after the failed fork and wrote 436k).
 * A `/cache-keeper:ping` fork (`pingManual`) is logged, never scored, and
 * answers with a line for the human; when it fails, the command's own turn
 * goes to the model at once (the human is waiting), never a retry or a drop.
 */
export function forked(input: ForkInput, ctx: Ctx): number {
  const sid = input.session_id
  const { home, hitRatio, delaySec, thresholds } = ctx.config
  if (!sid) return answer(ctx, { action: 'none' })
  const state = loadSession(home, sid)
  if (!state || !state.pendingPing || state.pingTransport !== 'fork') return answer(ctx, { action: 'none' })
  const f = input.fork
  const base = { t: iso(ctx.now), sessionId: sid, ctxTokens: state.ctxTokens, model: state.model }

  if (!f?.isAnswered || !f.usage) {
    const failure = f?.reason ?? 'no-result'
    const ageSec = cacheAgeSec(state, ctx.now)
    const retries = state.forkRetries ?? 0
    const manual = state.pingManual === true
    // The person came back (a prompt, or the answer to a question) since this ping went out:
    // their own turn reaches the cache now, and a fallback turn would land inside it.
    const personBack = (state.lastHumanAt ?? 0) > (state.lastPingAt ?? 0)
    const retry =
      !manual &&
      !personBack &&
      !FINAL_FORK_FAILURES.has(failure) &&
      retries < MAX_FORK_RETRIES &&
      ageSec + FORK_RETRY_SEC + FORK_TIMEOUT_SEC <= thresholds.maxAgeSec
    // A turn held open by a question takes no wake turn: a prompt sent now would land inside it.
    const waiting = state.waitingSince !== undefined
    const next = retry ? 'retry' : manual || (!waiting && !personBack && ageSec < thresholds.maxAgeSec) ? 'turn' : 'drop'
    appendLedger(home, { ...base, event: 'fork-failed', failure, next, ageSec })
    state.lastPingAt = ctx.now
    if (next === 'retry') {
      state.forkRetries = retries + 1
      state.forkRetryParked = true
      saveSession(home, state)
      return answer(ctx, { action: 'retry', afterSec: FORK_RETRY_SEC })
    }
    delete state.forkRetries
    if (next === 'drop') {
      closePing(state)
      saveSession(home, state)
      // The turn that ended while this fork ran left the re-arming to it (keepalive.ts `forking`).
      return answer(ctx, personBack ? { action: 'none', dueInSec: delaySec } : { action: 'none' })
    }
    // The ping goes on as a wake turn, which `record` closes. A manual one is already a
    // turn: the mod lets commands/ping.md reach the model, and `record` logs it as manual.
    state.pingTransport = 'turn'
    // A manual ping's turn now reaches the model: its Stop is a real one again.
    if (manual) delete state.gateTurnAt
    saveSession(home, state)
    return answer(ctx, { action: 'turn', text: WAKE_MESSAGE })
  }

  const usage = {
    inputTokens: n(f.usage.input_tokens),
    cacheRead: n(f.usage.cache_read_input_tokens),
    cacheWrite: n(f.usage.cache_creation_input_tokens),
    outputTokens: n(f.usage.output_tokens),
  }
  const manual = state.pingManual === true
  // The person came back while it ran: their turn is open, and must still read as open
  // (lastHumanAt after lastTurnEndAt), so no ping is timed from inside it. Its Stop sets the time.
  const personBack = (state.lastHumanAt ?? 0) > (state.lastPingAt ?? 0)
  closePing(state)
  // The read renewed the cache now: the next ping is timed from here.
  if (!personBack) state.lastTurnEndAt = ctx.now
  state.forkPingsHeld = (state.forkPingsHeld ?? 0) + 1
  saveForkClaim(home, sid, ctx.now)

  if (manual) {
    // Not scored: the oracle and the tuner judge keeper's own timing, not a ping the human asked for.
    // The mod answers the command's turn itself: its Stop touched nothing.
    state.gateTurnAt = ctx.now
    saveSession(home, state)
    appendLedger(home, { ...base, event: 'manual-ping', transport: 'fork', ...usage })
    return answer(ctx, { action: 'none', dueInSec: delaySec, text: manualPingText(usage, ctx.now + ctx.config.cacheTtlSec * 1000) })
  }

  // Input sent uncached counts against the hit, unlike a wake turn's few tokens of prompt.
  const denom = usage.cacheRead + usage.cacheWrite + usage.inputTokens
  const hit = denom > 0 && usage.cacheRead / denom >= hitRatio
  state.lastPingHit = hit
  saveSession(home, state)
  appendLedger(home, { ...base, event: hit ? 'wake-hit' : 'wake-miss', transport: 'fork', ...usage })
  return answer(ctx, { action: 'none', dueInSec: delaySec })
}

/** What `/cache-keeper:ping` answers once its fork came back. */
export function manualPingText(u: { cacheRead: number; cacheWrite: number }, warmUntil: number): string {
  if (u.cacheRead === 0) {
    return `cache-keeper: pinged, but nothing was read from the cache: it had gone cold. ${groupedTokens(u.cacheWrite)} tokens written, cached till ${hhmm(warmUntil)}.`
  }
  return `cache-keeper: pinged. Read ${groupedTokens(u.cacheRead)} cached tokens, wrote ${groupedTokens(u.cacheWrite)}; cached till ${hhmm(warmUntil)}.`
}

/** hooks/keepalive.ts gives a fork 120 s (FORK_TIMEOUT_MS), then up to 20 s for `forked`. */
export const MANUAL_FORK_MAX_MS = 140_000

/**
 * `/cache-keeper:ping` reached the mod: may a fork go out now? Unlike `fork-wake`
 * it asks no policy (the human is here and asked for it) and spends no
 * automatic budget, but it never pings into nothing: no turn yet, a cold
 * cache, a compacted prefix, or a ping already on its way. `pass` lets the
 * command's turn reach the model instead, which reads the cache as a wake turn.
 */
export function pingNow(input: ForkInput, ctx: Ctx): number {
  const sid = input.session_id
  const { home, enabled, forkPings, cacheTtlSec } = ctx.config
  const state = sid ? loadSession(home, sid) : undefined
  const refuse = (why: string) => {
    // The mod answers the command's turn with this: its Stop touched nothing.
    if (state) {
      state.gateTurnAt = ctx.now
      saveSession(home, state)
    }
    return answer(ctx, { action: 'none', text: `cache-keeper: no ping sent: ${why}.` })
  }
  if (!sid) return refuse('no session id')
  if (!enabled) return refuse('keeper is off (enabled: false)')
  const warmUntil = warmUntilOf(state, cacheTtlSec)
  if (!state || warmUntil === undefined) return refuse(NOTHING_TO_HOLD.noTurn)
  if (ctx.now >= warmUntil) return refuse(NOTHING_TO_HOLD.expired(warmUntil))
  if (compactedSinceRequest(state)) return refuse(NOTHING_TO_HOLD.compacted)
  if (state.pendingPing && ctx.now - (state.lastPingAt ?? 0) < PING_IN_FLIGHT_MS) return refuse('a ping is already on its way')
  // Logged once it comes back (`manual-ping`), not as a `ping`: keeper's own pings are what the report counts.
  // Open like any ping, so the Stop sleeper and the mod's timer do not send a second one meanwhile.
  state.pendingPing = true
  state.pingTransport = forkPings ? 'fork' : 'turn'
  state.pingManual = true
  state.lastPingAt = ctx.now
  // With a fork the mod answers the command's turn, even if the CLI fails after it: that Stop is the mod's.
  // Marked as of when the fork has ended at the latest, so a slow one does not push the Stop out of the window.
  if (forkPings) state.gateTurnAt = ctx.now + MANUAL_FORK_MAX_MS
  saveSession(home, state)
  // Without forks the command's own turn is the ping: `record` closes it.
  return answer(ctx, forkPings ? { action: 'fork', prompt: FORK_PROMPT } : { action: 'pass' })
}

/**
 * The mod's retry timer fired (`forked` answered `retry`): the fork goes again
 * unless a turn took the stretch meanwhile, or it could no longer land warm.
 */
export function forkRetry(input: ForkInput, ctx: Ctx): number {
  const sid = input.session_id
  const { home, thresholds } = ctx.config
  const state = sid ? loadSession(home, sid) : undefined
  if (!state || !state.pendingPing || state.pingTransport !== 'fork' || !state.forkRetries) {
    return answer(ctx, { action: 'none' })
  }
  const turnSince = (state.lastHumanAt ?? 0) > (state.lastPingAt ?? 0)
  const tooLate = cacheAgeSec(state, ctx.now) + FORK_TIMEOUT_SEC > thresholds.maxAgeSec
  if (turnSince || tooLate) {
    closePing(state)
    saveSession(home, state)
    return answer(ctx, { action: 'none' })
  }
  state.lastPingAt = ctx.now
  delete state.forkRetryParked
  saveSession(home, state)
  return answer(ctx, { action: 'fork', prompt: FORK_PROMPT })
}

/**
 * Leeway under the TTL: Claude Code's own check may run on a slightly
 * different clock, and `lastRequestAt` is when the last response ended, not
 * when its request was sent.
 */
const TTL_MARGIN_MS = 5 * 60_000

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
