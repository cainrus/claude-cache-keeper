/**
 * Handoff: when the keeper is about to let a session's cache go, spend one
 * last warm turn on a summary and make the session continue from it.
 *
 * The keeper stops pinging for good reasons (the human is away for hours, the
 * ping budget is spent), and the next real prompt then pays a full cache
 * rewrite of the whole context. At that moment the cache is still warm, so a
 * summary costs a cache read plus its own output. The session's transcript
 * then gets a `compact_boundary` and the summary appended — the same two
 * records `/compact` writes — and the session is restarted, so it reloads
 * only what follows the boundary.
 *
 * Fail closed, in this order:
 *   1. no summary on disk                         -> nothing touched
 *   2. the shortened transcript is tried on a COPY with a cheap headless
 *      `claude --resume`: the summary must be visible and a canary placed
 *      before the boundary must not be                -> else nothing touched,
 *      and handoff switches itself off (the CLI no longer honours the format)
 *   3. the transcript changed meanwhile (the human came back) -> nothing touched
 *   4. append to the real transcript, run the restart command
 *      -> on failure the transcript is truncated back to its old size
 *   5. the first real turn afterwards must show a smaller context
 *      -> else handoff switches itself off
 * Every outcome but 3 leaves a one-shot notice (see notices.ts).
 *
 *   handoffs/<session>.json   the record below
 *   handoffs/<session>.md     the summary the model wrote
 *   handoffs/<session>-<t>.jsonl  the transcript before the handoff
 *   handoff-disabled.json     present = switched off, with the reason
 */

import { copyFileSync, existsSync, readFileSync, rmSync, statSync, truncateSync, appendFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Config } from './config.ts'
import { appendLedger } from './ledger.ts'
import { postNotice } from './notices.ts'
import type { SkipReason } from './policy.ts'
import { readJson, writeJsonAtomic } from './state.ts'

/** Skip reasons after which the keeper would let a still-warm cache die. */
export const HANDOFF_REASONS: readonly SkipReason[] = ['away', 'away-budget-spent', 'budget-spent']

/** A handed-off session must come back at most this fraction of its old context. */
export const SHRINK_RATIO = 0.7

/** Shorter than this is not a summary. */
export const MIN_SUMMARY_CHARS = 400

export type HandoffStatus = 'requested' | 'applied' | 'checked' | 'failed'

export type HandoffFailure =
  | 'no-summary'
  | 'verify-failed'
  | 'verify-error'
  | 'transcript-changed'
  | 'restart-failed'
  | 'post-check'
  | 'error'

/** Failures that say the mechanism itself is broken, not this one session. */
const SYSTEMIC: ReadonlySet<HandoffFailure> = new Set(['verify-failed', 'post-check'])

export interface HandoffRecord {
  sessionId: string
  status: HandoffStatus
  requestedAt: number
  preCtx: number
  transcriptPath: string
  summaryPath: string
  backupPath?: string
  appliedAt?: number
  failure?: HandoffFailure
  detail?: string
}

const dir = (home: string) => join(home, 'handoffs')
export const summaryPath = (home: string, sid: string) => join(dir(home), `${sid}.md`)
export const recordPath = (home: string, sid: string) => join(dir(home), `${sid}.json`)
const disabledPath = (home: string) => join(home, 'handoff-disabled.json')

export function loadRecord(home: string, sid: string): HandoffRecord | undefined {
  return readJson<HandoffRecord>(recordPath(home, sid))
}

export function isHandoffDisabled(home: string): boolean {
  return existsSync(disabledPath(home))
}

export function enableHandoff(home: string): void {
  rmSync(disabledPath(home), { force: true })
}

export interface Eligibility {
  reason: SkipReason
  ageSec: number
  ctxTokens: number
  lastPingHit: boolean | null
  /** A handoff was already asked for in this idle stretch. */
  alreadyRequested: boolean
}

/** Would this refusal let a warm, large cache die that a handoff could save? */
export function wantsHandoff(e: Eligibility, config: Config): boolean {
  const h = config.handoff
  return (
    h.enabled &&
    h.restartCommand !== undefined &&
    HANDOFF_REASONS.includes(e.reason) &&
    e.ageSec < config.thresholds.maxAgeSec &&
    e.ctxTokens >= h.minCtxTokens &&
    e.lastPingHit !== false &&
    !e.alreadyRequested &&
    !isHandoffDisabled(config.home)
  )
}

export function handoffMessage(marker: string, path: string): string {
  return (
    `${marker} Handoff: this idle session's prompt cache is about to expire, and the next turn would ` +
    `re-send the whole context. Write a self-contained handoff summary to ${path} with the Write tool, ` +
    `so the work can continue from it alone: the user's goal and every open request; decisions made and ` +
    `why; the current state of the work and of any plan or task list; files, branches and commands that ` +
    `matter; open questions; the exact next step. Then add the last few exchanges, condensed. ` +
    `Change nothing else. Then reply with exactly "ok".`
  )
}

export function requestHandoff(home: string, sid: string, preCtx: number, transcriptPath: string, now: number): string {
  const path = summaryPath(home, sid)
  rmSync(path, { force: true })
  const rec: HandoffRecord = { sessionId: sid, status: 'requested', requestedAt: now, preCtx, transcriptPath, summaryPath: path }
  writeJsonAtomic(recordPath(home, sid), rec)
  appendLedger(home, { t: new Date(now).toISOString(), sessionId: sid, event: 'handoff-request', ctxTokens: preCtx })
  return path
}

// --- the splice ---------------------------------------------------------------

function records(text: string): any[] {
  const out: any[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // a torn line: not a parent candidate
    }
  }
  return out
}

/** The launch cwd: it names the project directory `--resume` looks the session up in. */
export function transcriptCwd(text: string): string | undefined {
  return records(text).find((r) => typeof r.cwd === 'string')?.cwd
}

export interface SpliceInput {
  sessionId: string
  summary: string
  handoffId: string
  backupPath: string
  now: number
  /** Verification only: a user message placed BEFORE the boundary. */
  canary?: string
}

/**
 * The records to append: [canary,] compact_boundary, summary — shaped like the
 * ones `/compact` writes (Claude Code 2.1.27x), minus its bookkeeping fields.
 */
export function buildSplice(text: string, s: SpliceInput): string[] {
  const all = records(text)
  const last = [...all].reverse().find((r) => typeof r.uuid === 'string')
  const base = [...all].reverse().find((r) => typeof r.version === 'string') ?? {}
  const common = {
    isSidechain: false,
    userType: base.userType ?? 'external',
    entrypoint: base.entrypoint ?? 'cli',
    cwd: base.cwd,
    sessionId: s.sessionId,
    version: base.version,
    ...(base.gitBranch ? { gitBranch: base.gitBranch } : {}),
  }
  const t = new Date(s.now).toISOString()
  const out: string[] = []
  let parent: string | null = last?.uuid ?? null

  if (s.canary !== undefined) {
    const uuid = randomUUID()
    out.push(JSON.stringify({ parentUuid: parent, ...common, type: 'user', uuid, timestamp: t, message: { role: 'user', content: s.canary } }))
    parent = uuid
  }

  const boundary = randomUUID()
  out.push(
    JSON.stringify({
      parentUuid: null,
      logicalParentUuid: parent,
      ...common,
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      level: 'info',
      uuid: boundary,
      timestamp: t,
      compactMetadata: { trigger: 'manual' },
    }),
  )
  out.push(
    JSON.stringify({
      parentUuid: boundary,
      ...common,
      type: 'user',
      isVisibleInTranscriptOnly: true,
      isCompactSummary: true,
      uuid: randomUUID(),
      timestamp: t,
      message: {
        role: 'user',
        content:
          'This session is being continued from a previous conversation whose prompt cache expired. ' +
          'The summary below was written by the session itself just before that.\n\nSummary:\n' +
          `${s.summary.trim()}\n\n` +
          `(HANDOFF-ID ${s.handoffId}. The full earlier transcript is kept at ${s.backupPath} — ` +
          'read it when a detail is missing.)',
      },
    }),
  )
  return out
}

// --- apply ----------------------------------------------------------------------

export interface ClaudeRun {
  status: number | null
  stdout: string
}

export interface ApplyDeps {
  config: Config
  now: () => number
  /** Headless `claude` with the given args in `cwd`; hooks off, keeper off. */
  runClaude: (args: string[], cwd: string) => ClaudeRun
  /** The configured restart command for this session; true = it will reload the transcript. */
  runRestart: (command: string, sessionId: string, transcriptPath: string) => boolean
}

export type ApplyResult = { ok: true; verifyCtx: number } | { ok: false; failure: HandoffFailure; detail?: string }

const VERIFY_PROMPT =
  'Answer on one line, nothing else: the HANDOFF-ID from the conversation summary (or NONE), ' +
  'then the CANARY code if one appears anywhere in this conversation (or NONE).'

/** Try the shortened transcript on a throwaway copy of the session. */
export interface VerifyResult {
  ok: boolean
  /** The model answered: a wrong answer then is about the format, not the environment. */
  ran: boolean
  ctx: number
  detail: string
}

export function verifyOnCopy(text: string, transcriptPath: string, s: SpliceInput, deps: ApplyDeps): VerifyResult {
  const copyId = randomUUID()
  const canary = `CANARY-${randomUUID().slice(0, 8)}`
  const copyPath = join(dirname(transcriptPath), `${copyId}.jsonl`)
  const copied = text.replaceAll(s.sessionId, copyId)
  const splice = buildSplice(copied, { ...s, sessionId: copyId, canary: `${canary} — remember this code.` })
  const nl = copied === '' || copied.endsWith('\n') ? '' : '\n'
  writeFileSync(copyPath, `${copied}${nl}${splice.join('\n')}\n`)
  try {
    const cwd = transcriptCwd(text) ?? process.cwd()
    const r = deps.runClaude(['-p', VERIFY_PROMPT, '--resume', copyId, '--model', deps.config.handoff.verifyModel, '--output-format', 'json'], cwd)
    let out: any
    try {
      out = JSON.parse(r.stdout)
    } catch {
      return { ok: false, ran: false, ctx: 0, detail: `exit ${r.status}, no json` }
    }
    // A run that never reached the model (auth, network, limits) says nothing about the format.
    if (out?.is_error === true || r.status !== 0) return { ok: false, ran: false, ctx: 0, detail: String(out?.result ?? `exit ${r.status}`).slice(0, 80) }
    const u = out?.usage ?? {}
    const ctx = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    const answer = String(out?.result ?? '')
    if (!answer.includes(s.handoffId)) return { ok: false, ran: true, ctx, detail: `summary not seen: ${answer.slice(0, 80)}` }
    if (answer.includes(canary)) return { ok: false, ran: true, ctx, detail: 'history before the boundary still loaded' }
    return { ok: true, ran: true, ctx, detail: answer.slice(0, 80) }
  } finally {
    rmSync(copyPath, { force: true })
  }
}

function fail(home: string, rec: HandoffRecord, failure: HandoffFailure, now: number, detail?: string): ApplyResult {
  writeJsonAtomic(recordPath(home, rec.sessionId), { ...rec, status: 'failed', failure, ...(detail ? { detail } : {}) })
  appendLedger(home, { t: new Date(now).toISOString(), sessionId: rec.sessionId, event: 'handoff-failed', failure, ...(detail ? { detail } : {}) })
  if (failure === 'transcript-changed') return { ok: false, failure, detail }
  const systemic = SYSTEMIC.has(failure)
  if (systemic) writeJsonAtomic(disabledPath(home), { t: now, sessionId: rec.sessionId, failure, detail })
  const why = `${failure}${detail ? `: ${detail}` : ''}`
  postNotice(
    home,
    (failure === 'post-check'
      ? `cache-keeper: session ${rec.sessionId.slice(0, 8)} was handed off but came back at full size (${why}).`
      : `cache-keeper: handoff of session ${rec.sessionId.slice(0, 8)} rolled back (${why}); its transcript is as it was.`) +
      (systemic ? ' Handoff is off until `cache-keeper handoff-enable`.' : ''),
    now,
  )
  return { ok: false, failure, detail }
}

export function applyHandoff(sid: string, deps: ApplyDeps): ApplyResult {
  const { home } = deps.config
  const rec = loadRecord(home, sid)
  if (!rec || rec.status !== 'requested') return { ok: false, failure: 'error', detail: 'no pending handoff' }
  const now = deps.now()
  try {
    let summary = ''
    try {
      summary = readFileSync(rec.summaryPath, 'utf8')
    } catch {}
    if (summary.trim().length < MIN_SUMMARY_CHARS) return fail(home, rec, 'no-summary', now)

    const sizeBefore = statSync(rec.transcriptPath).size
    const backupPath = join(dir(home), `${sid}-${now}.jsonl`)
    copyFileSync(rec.transcriptPath, backupPath)
    const text = readFileSync(backupPath, 'utf8')
    const splice: SpliceInput = { sessionId: sid, summary, handoffId: `H-${randomUUID().slice(0, 8)}`, backupPath, now }

    const v = verifyOnCopy(text, rec.transcriptPath, splice, deps)
    if (!v.ran) return fail(home, { ...rec, backupPath }, 'verify-error', deps.now(), v.detail)
    if (!v.ok || v.ctx >= rec.preCtx * SHRINK_RATIO) {
      return fail(home, { ...rec, backupPath }, 'verify-failed', deps.now(), v.ok ? `context ${v.ctx} of ${rec.preCtx}` : v.detail)
    }

    if (statSync(rec.transcriptPath).size !== sizeBefore) return fail(home, { ...rec, backupPath }, 'transcript-changed', deps.now())
    const nl = text === '' || text.endsWith('\n') ? '' : '\n'
    appendFileSync(rec.transcriptPath, `${nl}${buildSplice(text, splice).join('\n')}\n`)
    const sizeAfter = statSync(rec.transcriptPath).size

    if (!deps.runRestart(deps.config.handoff.restartCommand!, sid, rec.transcriptPath)) {
      if (statSync(rec.transcriptPath).size === sizeAfter) truncateSync(rec.transcriptPath, sizeBefore)
      return fail(home, { ...rec, backupPath }, 'restart-failed', deps.now())
    }

    const appliedAt = deps.now()
    writeJsonAtomic(recordPath(home, sid), { ...rec, status: 'applied', backupPath, appliedAt })
    appendLedger(home, { t: new Date(appliedAt).toISOString(), sessionId: sid, event: 'handoff', ctxTokens: rec.preCtx, verifyCtx: v.ctx })
    postNotice(
      home,
      `cache-keeper: this session was handed off before its cache expired — it continues from a summary ` +
        `instead of ${Math.round(rec.preCtx / 1000)}k tokens of context. Full earlier transcript: ${backupPath}`,
      appliedAt,
      [sid],
    )
    return { ok: true, verifyCtx: v.ctx }
  } catch (err) {
    return fail(home, rec, 'error', deps.now(), (err as Error)?.message)
  }
}

/** On a real turn after a handoff: did the session really come back smaller? */
export function postCheck(home: string, sid: string, usage: { ctxTokens: number; timestamp?: number }, now: number): void {
  const rec = loadRecord(home, sid)
  if (!rec || rec.status !== 'applied' || rec.appliedAt === undefined) return
  if (usage.timestamp !== undefined && usage.timestamp < rec.appliedAt) return
  if (usage.ctxTokens < rec.preCtx * SHRINK_RATIO) {
    writeJsonAtomic(recordPath(home, sid), { ...rec, status: 'checked' })
    appendLedger(home, { t: new Date(now).toISOString(), sessionId: sid, event: 'handoff-checked', ctxTokens: usage.ctxTokens })
    return
  }
  fail(home, rec, 'post-check', now, `context ${usage.ctxTokens} of ${rec.preCtx}`)
}
