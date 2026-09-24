/**
 * The hook subcommands. Each takes the parsed hook input plus an explicit
 * context (clock, config, presence probe, stderr) and returns an exit code, so
 * the whole flow runs in-process under test without Claude Code.
 *
 *   Stop              -> record   (sync)   remember when the cache was touched, score a wake
 *   Stop              -> wake     (after `sleep`, asyncRewake) decide, maybe exit 2
 *   UserPromptSubmit  -> touch             a real prompt closes the idle stretch
 *   SessionEnd        -> end               forget the session
 */

import type { Config } from './config.ts'
import { appendLedger } from './ledger.ts'
import { decide, isAtKeyboard } from './policy.ts'
import {
  deleteSession,
  loadAwayBudget,
  loadSession,
  newSession,
  saveAwayBudget,
  saveSession,
} from './state.ts'
import { lastMainUsage } from './transcript.ts'

export const WAKE_MARKER = '[cache-keeper] Prompt-cache keep-alive.'
export const WAKE_MESSAGE = `${WAKE_MARKER} Reply with exactly "ok". No tools, no commentary.`

export interface HookInput {
  session_id?: string
  transcript_path?: string
  hook_event_name?: string
  stop_hook_active?: boolean
  prompt?: string
}

export interface Ctx {
  config: Config
  /** Epoch ms. */
  now: number
  /** Keyboard idle seconds, null = unknown. Called at most once per wake. */
  idleSeconds: () => number | null
  stderr: (text: string) => void
  /** Blocking sleep, injectable for tests. Defaults to Atomics.wait. */
  sleepMs?: (ms: number) => void
}

const blockingSleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** How long `record` waits for the transcript to catch up with the turn it closes. */
export const TRANSCRIPT_CATCH_UP_MS = 3000
const CATCH_UP_STEP_MS = 100

/**
 * The Stop hook can run before Claude Code has flushed the assistant entry of
 * the turn it closes (seen live: the entry's timestamp predates the hook, the
 * line is not on disk yet). Reading then returns the PREVIOUS turn's usage —
 * for a wake, the previous wake's numbers. So poll until an entry at least as
 * new as the prompt that started this turn shows up; undefined when it never
 * does, so the caller can record "not scored" instead of stale numbers.
 */
function usageSince(path: string, sinceMs: number, ctx: Ctx) {
  const sleep = ctx.sleepMs ?? blockingSleep
  for (let waited = 0; ; waited += CATCH_UP_STEP_MS) {
    const usage = lastMainUsage(path)
    if (usage && (usage.timestamp === undefined || usage.timestamp >= sinceMs)) return usage
    if (waited >= TRANSCRIPT_CATCH_UP_MS) return undefined
    sleep(CATCH_UP_STEP_MS)
  }
}

const iso = (ms: number) => new Date(ms).toISOString()
const secondsBetween = (from: number, to: number) => Math.max(0, Math.floor((to - from) / 1000))

export function isWakePrompt(prompt: string | undefined): boolean {
  return typeof prompt === 'string' && prompt.includes(WAKE_MARKER)
}

/** Stop (sync): record the finished turn; if it closed a wake, score the ping. */
export function record(input: HookInput, ctx: Ctx): number {
  const sid = input.session_id
  if (!sid) return 0
  const { home, hitRatio } = ctx.config
  const state = loadSession(home, sid) ?? newSession(sid)
  if (input.transcript_path) state.transcriptPath = input.transcript_path

  // The turn this Stop closes began at our wake (pendingPing) or at the last
  // real prompt; its assistant entry cannot be older than that.
  const turnBegan = state.pendingPing ? (state.lastPingAt ?? 0) : (state.lastHumanAt ?? 0)
  const usage = state.transcriptPath ? usageSince(state.transcriptPath, turnBegan, ctx) : undefined

  // The cache was last touched by the request that produced the last assistant
  // entry, so its timestamp — not this hook's clock — is when the TTL restarted.
  // Using it also keeps the sleeper started by this very Stop from racing this
  // write: with delay == minAgeSec, "now" here could land a few hundred ms
  // after the sleeper began and make it look stale. An entry older than the
  // last human prompt means the transcript has not caught up yet: use now.
  const ts = usage?.timestamp
  state.lastTurnEndAt = ts !== undefined && ts >= (state.lastHumanAt ?? 0) ? Math.min(ts, ctx.now) : ctx.now

  if (usage) {
    state.ctxTokens = usage.ctxTokens
    if (usage.model) state.model = usage.model
  }

  // Only a Stop that follows our own wake is scored. `stop_hook_active` alone
  // is also set when some other Stop hook blocked the turn; scoring that turn
  // could record a spurious miss and mute this session for good.
  if (state.pendingPing) {
    state.pendingPing = false
    if (usage) {
      const denom = usage.cacheRead + usage.cacheWrite
      const hit = denom > 0 && usage.cacheRead / denom >= hitRatio
      state.lastPingHit = hit
      appendLedger(home, {
        t: iso(ctx.now),
        sessionId: sid,
        event: hit ? 'wake-hit' : 'wake-miss',
        ctxTokens: usage.ctxTokens,
        model: usage.model,
        inputTokens: usage.inputTokens,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        outputTokens: usage.outputTokens,
      })
    }
  }

  saveSession(home, state)
  return 0
}

/** After the sleep: decide whether this idle session gets a ping (exit 2) or not (exit 0). */
export function wake(input: HookInput, ctx: Ctx): number {
  const { home, thresholds, enabled } = ctx.config
  const sid = input.session_id
  if (!enabled || !sid) return 0
  const state = loadSession(home, sid)
  if (!state || state.lastTurnEndAt === undefined) return 0

  // A newer turn ended (or started) since this sleeper was armed: its own
  // sleeper owns the session now.
  const ageSec = secondsBetween(state.lastTurnEndAt, ctx.now)
  const turnStartedSince = (state.lastHumanAt ?? 0) > state.lastTurnEndAt
  if (ageSec < thresholds.minAgeSec || turnStartedSince) return 0

  const awaySeconds = ctx.idleSeconds()
  const atKeyboard = isAtKeyboard(awaySeconds, thresholds)
  const budget = loadAwayBudget(home)
  if (atKeyboard && budget.awayPingsSincePresence !== 0) {
    budget.awayPingsSincePresence = 0
    budget.updatedAt = ctx.now
    saveAwayBudget(home, budget)
  }

  const decision = decide(
    {
      awaySeconds,
      ageSec,
      ctxTokens: state.ctxTokens,
      pingsSoFar: state.pingsSoFar,
      awayPingsSincePresence: budget.awayPingsSincePresence,
      lastPingHit: state.lastPingHit,
    },
    thresholds,
  )

  const base = { t: iso(ctx.now), sessionId: sid, ctxTokens: state.ctxTokens, ageSec, model: state.model, awaySeconds }
  if (!decision.ping) {
    appendLedger(home, { ...base, event: 'skip', reason: decision.reason })
    return 0
  }

  state.pendingPing = true
  state.pingsSoFar += 1
  state.lastPingAt = ctx.now
  saveSession(home, state)
  if (!atKeyboard) {
    budget.awayPingsSincePresence += 1
    budget.updatedAt = ctx.now
    saveAwayBudget(home, budget)
  }
  appendLedger(home, { ...base, event: 'ping' })
  ctx.stderr(`${WAKE_MESSAGE}\n`)
  return 2
}

/** UserPromptSubmit: a real prompt closes the idle stretch. The wake turn's own prompt is ignored. */
export function touch(input: HookInput, ctx: Ctx): number {
  const sid = input.session_id
  if (!sid || isWakePrompt(input.prompt)) return 0
  const { home } = ctx.config
  const state = loadSession(home, sid) ?? newSession(sid)
  if (input.transcript_path) state.transcriptPath = input.transcript_path

  if (state.pingsSoFar > 0) {
    appendLedger(home, {
      t: iso(ctx.now),
      sessionId: sid,
      event: 'resume',
      pings: state.pingsSoFar,
      lastPingHit: state.lastPingHit,
      ctxTokens: state.ctxTokens,
      model: state.model,
      ...(state.lastTurnEndAt !== undefined ? { ageSec: secondsBetween(state.lastTurnEndAt, ctx.now) } : {}),
    })
  }

  state.pingsSoFar = 0
  state.pendingPing = false
  state.lastHumanAt = ctx.now
  saveSession(home, state)
  return 0
}

/** SessionEnd: drop the session's state. A sleeper still pending will find nothing and exit 0. */
export function end(input: HookInput, ctx: Ctx): number {
  if (input.session_id) deleteSession(ctx.config.home, input.session_id)
  return 0
}
