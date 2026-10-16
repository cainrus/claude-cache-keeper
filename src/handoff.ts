/**
 * Handoff: when the keeper is about to let a session's cache go, spend one
 * last warm turn on a brief — and, when the human comes back to a cold cache,
 * let them choose where to continue before anything reaches the model.
 *
 * The keeper stops pinging for good reasons (the human is away for hours, the
 * ping budget is spent), and the next real prompt then pays a full cache
 * rewrite of the whole context. At that moment the cache is still warm, so a
 * brief costs a cache read plus its own output. The transcript is not touched.
 *
 *   1. wake    the refusal turns into one more wake: write a brief for a NEW
 *              session to `handoffs/<session>.md`
 *   2. record  the Stop closing that wake: brief on disk -> `ready`, else
 *              `failed` with a one-shot notice
 *   3. touch   a real prompt while `ready`:
 *                cache still warm -> passes, the brief is retired (`used`)
 *                cache cold       -> blocked: the model is not called, the
 *                                    text goes back to the input box and the
 *                                    menu below is shown
 *              after the menu:
 *                the same text again, `1` or `force` -> continue here
 *                `2` -> the configured spawn command starts a new session
 *                       from the brief plus the held message; on exit 0 this
 *                       session is closed a moment after the hook returns
 *                anything else -> held instead, the menu again
 *
 * `!` commands and slash commands do not go through UserPromptSubmit (measured
 * on Claude Code 2.1.301; skills do). The plugin's mod (hooks/gate.ts) asks the
 * same question where they do pass: before a model request (`turn.step`) and
 * before `/compact` (`session.compact`). The held "message" is then the turn's
 * first text or the command name.
 *
 *   handoffs/<session>.json            the record below
 *   handoffs/<session>.md              the brief the model wrote
 *   handoffs/<session>-continue.md     brief + held message, given to the spawn command
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from './config.ts'
import { appendLedger } from './ledger.ts'
import { postNotice } from './notices.ts'
import type { SkipReason } from './policy.ts'
import { basePrice, MULT } from './report.ts'
import { readJson, writeJsonAtomic, type SessionState } from './state.ts'

/** Skip reasons after which the keeper would let a still-warm cache die. */
export const HANDOFF_REASONS: readonly SkipReason[] = ['away', 'away-budget-spent', 'budget-spent']

/** Shorter than this is not a brief. */
export const MIN_BRIEF_CHARS = 400

/** Spawn output shown in the menu answer is cut to this. */
const OUTPUT_CHARS = 600

export type HandoffStatus = 'requested' | 'ready' | 'used' | 'failed'

export interface HandoffRecord {
  sessionId: string
  status: HandoffStatus
  requestedAt: number
  preCtx: number
  model?: string
  transcriptPath: string
  briefPath: string
  readyAt?: number
  failure?: 'no-brief'
  /** The prompt the menu is holding. */
  heldPrompt?: string
  menuShownAt?: number
  usedAt?: number
  /** warm = came back before the cache died; here / new = picked in the menu. */
  choice?: 'warm' | 'here' | 'new'
  continuePath?: string
}

const dir = (home: string) => join(home, 'handoffs')
export const briefPath = (home: string, sid: string) => join(dir(home), `${sid}.md`)
export const recordPath = (home: string, sid: string) => join(dir(home), `${sid}.json`)
export const continuePath = (home: string, sid: string) => join(dir(home), `${sid}-continue.md`)

export function loadRecord(home: string, sid: string): HandoffRecord | undefined {
  return readJson<HandoffRecord>(recordPath(home, sid))
}

function saveRecord(home: string, rec: HandoffRecord): void {
  writeJsonAtomic(recordPath(home, rec.sessionId), rec)
}

export interface Eligibility {
  reason: SkipReason
  ageSec: number
  ctxTokens: number
  lastPingHit: boolean | null
  /** A handoff was already asked for in this idle stretch. */
  alreadyRequested: boolean
}

/** Would this refusal let a warm, large cache die that a brief could save? */
export function wantsHandoff(e: Eligibility, config: Config): boolean {
  const h = config.handoff
  return (
    h.enabled &&
    HANDOFF_REASONS.includes(e.reason) &&
    e.ageSec < config.thresholds.maxAgeSec &&
    e.ctxTokens >= h.minCtxTokens &&
    e.lastPingHit !== false &&
    !e.alreadyRequested
  )
}

export function handoffMessage(marker: string, path: string): string {
  return (
    `${marker} Handoff: this idle session's prompt cache is about to expire. The user may continue in a NEW ` +
    `session that has never seen this conversation. Write a self-contained brief for it to ${path} with the ` +
    `Write tool: the user's goal and every open request; decisions made and why, and what was ruled out; the ` +
    `current state of the work and of any plan or task list; files, branches and commands that matter; open ` +
    `questions; the exact next step. Then add the last few exchanges, condensed. Change nothing else. ` +
    `Then reply with exactly "ok".`
  )
}

export function requestHandoff(home: string, state: SessionState, now: number): string {
  const sid = state.sessionId
  const path = briefPath(home, sid)
  rmSync(path, { force: true })
  saveRecord(home, {
    sessionId: sid,
    status: 'requested',
    requestedAt: now,
    preCtx: state.ctxTokens,
    ...(state.model ? { model: state.model } : {}),
    transcriptPath: state.transcriptPath!,
    briefPath: path,
  })
  appendLedger(home, { t: new Date(now).toISOString(), sessionId: sid, event: 'handoff-request', ctxTokens: state.ctxTokens })
  return path
}

/** The Stop closing the handoff wake: is there a brief to offer later? */
export function settleHandoff(home: string, sid: string, now: number): void {
  const rec = loadRecord(home, sid)
  if (!rec || rec.status !== 'requested') return
  let brief = ''
  try {
    brief = readFileSync(rec.briefPath, 'utf8')
  } catch {}
  const t = new Date(now).toISOString()
  if (brief.trim().length < MIN_BRIEF_CHARS) {
    saveRecord(home, { ...rec, status: 'failed', failure: 'no-brief' })
    appendLedger(home, { t, sessionId: sid, event: 'handoff-failed', failure: 'no-brief' })
    postNotice(home, `cache-keeper: session ${sid.slice(0, 8)} was asked for a handoff brief and wrote none.`, now, [sid])
    return
  }
  saveRecord(home, { ...rec, status: 'ready', readyAt: now })
  appendLedger(home, { t, sessionId: sid, event: 'handoff-ready', ctxTokens: rec.preCtx })
}

// --- the menu -----------------------------------------------------------------------

export interface SpawnResult {
  ok: boolean
  output: string
}

/** The process side, injected so touch stays testable (see handoff-run.ts). */
export interface HandoffIO {
  /** Run the spawn command with the given extra env; ok = exit 0. */
  spawn: (command: string, env: Record<string, string>) => SpawnResult
  /** Close this session shortly after the hook has returned. */
  closeLater: (sessionId: string) => void
}

export type Interception =
  /** Let the prompt through; `context` reaches the model with it. */
  | { kind: 'pass'; context?: string }
  /** Stop the prompt before the model; `reason` is shown to the human. */
  | { kind: 'block'; reason: string }

const CONTINUE_HERE = new Set(['1', 'force'])

function idleText(ms: number): string {
  const min = Math.floor(ms / 60_000)
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`
}

export function coldRewriteUsd(ctxTokens: number, model: string | undefined, config: Config): number {
  return (ctxTokens * MULT.cacheWrite * basePrice(model, config.prices)) / 1e6
}

function menu(rec: HandoffRecord, state: SessionState, config: Config, now: number, gate: boolean): string {
  const ctx = state.ctxTokens || rec.preCtx
  const idle = state.lastTurnEndAt !== undefined ? ` (idle ${idleText(now - state.lastTurnEndAt)})` : ''
  const usd = coldRewriteUsd(ctx, state.model ?? rec.model, config).toFixed(2)
  const spawn = config.handoff.spawnCommand
  const second = spawn
    ? `  2      continue in a new session from the brief, with your message${config.handoff.closeAfterSpawn ? '; this session closes' : ''}`
    : '  2      write the brief plus your message to a file, to start a new session from'
  return [
    `cache-keeper: this session's prompt cache has gone cold${idle}; the next turn re-sends ~${Math.round(ctx / 1000)}k tokens (≈ $${usd}).`,
    `A handoff brief was written before it expired: ${rec.briefPath}`,
    gate
      ? '  Enter  run the same command again to continue here (or send 1)'
      : '  Enter  send the same message again to continue here (or type 1)',
    second,
    gate
      ? 'Your command is held. Nothing was sent to the model.'
      : 'Your message is held and is back in the input box. Nothing was sent to the model.',
  ].join('\n')
}

function cwdOf(transcriptPath: string): string | undefined {
  try {
    for (const line of readFileSync(transcriptPath, 'utf8').split('\n')) {
      if (!line.includes('"cwd"')) continue
      try {
        const cwd = JSON.parse(line).cwd
        if (typeof cwd === 'string') return cwd
      } catch {}
    }
  } catch {}
  return undefined
}

function writeContinue(home: string, rec: HandoffRecord): string {
  const path = continuePath(home, rec.sessionId)
  const brief = readFileSync(rec.briefPath, 'utf8').trim()
  const held = rec.heldPrompt?.trim()
  const tail = held ? `\n\n## The user's message on return\n\n${held}\n` : '\n'
  writeFileSync(
    path,
    `${brief}\n\n(Continued from session ${rec.sessionId}; its full transcript is ${rec.transcriptPath}. ` +
      `Read it only when a detail is missing.)${tail}`,
  )
  return path
}

function startNew(rec: HandoffRecord, config: Config, io: HandoffIO | undefined, now: number): Interception {
  const home = config.home
  const path = writeContinue(home, rec)
  const { spawnCommand, closeAfterSpawn } = config.handoff
  if (!spawnCommand || !io) {
    saveRecord(home, { ...rec, continuePath: path })
    return { kind: 'block', reason: `cache-keeper: start a new session from ${path} — this one stays as it is.` }
  }
  const cwd = cwdOf(rec.transcriptPath)
  const r = io.spawn(spawnCommand, {
    CACHE_KEEPER_BRIEF: path,
    CACHE_KEEPER_SESSION_ID: rec.sessionId,
    CACHE_KEEPER_TRANSCRIPT_PATH: rec.transcriptPath,
    ...(cwd ? { CACHE_KEEPER_CWD: cwd } : {}),
  })
  const out = r.output.trim().slice(-OUTPUT_CHARS)
  const t = new Date(now).toISOString()
  if (!r.ok) {
    saveRecord(home, { ...rec, continuePath: path })
    appendLedger(home, { t, sessionId: rec.sessionId, event: 'handoff-failed', failure: 'spawn' })
    return {
      kind: 'block',
      reason: `cache-keeper: the new session did not start; this one stays.${out ? `\n${out}` : ''}\nBrief: ${path}`,
    }
  }
  saveRecord(home, { ...rec, status: 'used', choice: 'new', usedAt: now, continuePath: path })
  appendLedger(home, { t, sessionId: rec.sessionId, event: 'handoff-new', ctxTokens: rec.preCtx })
  if (closeAfterSpawn) io.closeLater(rec.sessionId)
  return {
    kind: 'block',
    reason: `cache-keeper: continued in a new session${closeAfterSpawn ? '; this one is closing' : ''}.${out ? `\n${out}` : ''}`,
  }
}

/**
 * A real prompt arrives: undefined = nothing to do with handoff. Called by
 * touch before it records the prompt; a block means the prompt never ran.
 */
export function interceptPrompt(
  prompt: string,
  state: SessionState,
  config: Config,
  now: number,
  io?: HandoffIO,
  gate = false,
): Interception | undefined {
  const home = config.home
  const rec = loadRecord(home, state.sessionId)
  if (!rec || rec.status !== 'ready') return undefined
  const t = new Date(now).toISOString()
  const cold = state.lastTurnEndAt !== undefined && now - state.lastTurnEndAt >= config.cacheTtlSec * 1000

  if (!cold) {
    // Back before the cache died: the conversation goes on and the brief goes stale.
    saveRecord(home, { ...rec, status: 'used', choice: 'warm', usedAt: now })
    return { kind: 'pass' }
  }

  const text = prompt.trim()
  if (rec.heldPrompt !== undefined) {
    if (text === '2') return startNew(rec, config, io, now)
    if (text === rec.heldPrompt.trim() || CONTINUE_HERE.has(text.toLowerCase())) {
      saveRecord(home, { ...rec, status: 'used', choice: 'here', usedAt: now })
      appendLedger(home, { t, sessionId: rec.sessionId, event: 'handoff-here', ctxTokens: state.ctxTokens })
      return text === rec.heldPrompt.trim()
        ? { kind: 'pass' }
        : { kind: 'pass', context: `The user's message, held while cache-keeper asked where to continue:\n\n${rec.heldPrompt}` }
    }
  }
  const held = { ...rec, heldPrompt: prompt, menuShownAt: now }
  saveRecord(home, held)
  return { kind: 'block', reason: menu(held, state, config, now, gate) }
}
