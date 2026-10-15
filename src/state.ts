/**
 * On-disk state under `$CACHE_KEEPER_HOME`:
 *
 *   sessions/<session_id>.json   per-session state
 *   away-budget.json             the machine-wide away bucket
 *   ledger.jsonl                 one line per decision (see ledger.ts)
 *
 * Every write is `write tmp + rename`, so a reader never sees half a file. Two
 * hooks racing on the same file can lose an update; for the away budget that
 * costs one extra ping, never an unbounded number.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

export interface SessionState {
  sessionId: string
  transcriptPath?: string
  /** Epoch ms when the cache was last touched by a finished turn (real or wake). */
  lastTurnEndAt?: number
  /** Epoch ms of the last real (non-wake) prompt. */
  lastHumanAt?: number
  /** Epoch ms of the last ping this session was sent. */
  lastPingAt?: number
  ctxTokens: number
  model?: string
  pingsSoFar: number
  /** A wake was sent and its closing Stop has not been recorded yet. */
  pendingPing: boolean
  lastPingHit: boolean | null
  /** A handoff was asked for in this idle stretch (reset by a real prompt). */
  handoffRequested?: boolean
  /** The open wake is a handoff: its closing Stop checks the brief. */
  handoffPending?: boolean
}

export interface AwayBudget {
  awayPingsSincePresence: number
  updatedAt?: number
}

export function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
}

/** Session ids are UUIDs; anything else is flattened so it cannot escape the directory. */
export function safeId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_')
  return cleaned === '' ? '_' : cleaned
}

export function sessionPath(home: string, sessionId: string): string {
  return join(home, 'sessions', `${safeId(sessionId)}.json`)
}

export function newSession(sessionId: string): SessionState {
  return { sessionId, ctxTokens: 0, pingsSoFar: 0, pendingPing: false, lastPingHit: null }
}

export function loadSession(home: string, sessionId: string): SessionState | undefined {
  const s = readJson<SessionState>(sessionPath(home, sessionId))
  return s && typeof s === 'object' ? { ...newSession(sessionId), ...s } : undefined
}

export function saveSession(home: string, state: SessionState): void {
  writeJsonAtomic(sessionPath(home, state.sessionId), state)
}

export function deleteSession(home: string, sessionId: string): void {
  rmSync(sessionPath(home, sessionId), { force: true })
}

export function awayBudgetPath(home: string): string {
  return join(home, 'away-budget.json')
}

export function loadAwayBudget(home: string): AwayBudget {
  const b = readJson<AwayBudget>(awayBudgetPath(home))
  const n = b?.awayPingsSincePresence
  return { awayPingsSincePresence: typeof n === 'number' && n >= 0 ? n : 0, updatedAt: b?.updatedAt }
}

export function saveAwayBudget(home: string, budget: AwayBudget): void {
  writeJsonAtomic(awayBudgetPath(home), budget)
}
