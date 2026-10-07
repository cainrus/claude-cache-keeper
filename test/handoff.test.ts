import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { record, touch, wake, WAKE_MARKER } from '../src/commands.ts'
import {
  applyHandoff,
  buildSplice,
  enableHandoff,
  isHandoffDisabled,
  loadRecord,
  postCheck,
  requestHandoff,
  summaryPath,
  type ApplyDeps,
  type ClaudeRun,
} from '../src/handoff.ts'
import { readLedger } from '../src/ledger.ts'
import { postNotice, takeNotices, NOTICE_TTL_MS } from '../src/notices.ts'
import { THRESHOLDS as T } from '../src/policy.ts'
import { loadSession, newSession, saveSession } from '../src/state.ts'
import { assistantLine, configFor, makeCtx, MIN, SID, tempHome } from './helpers.ts'

const T0 = Date.parse('2026-01-01T10:00:00.000Z')
const PRE = 150_000
const SUMMARY = `Goal: ship the handoff POC.\n${'Decisions and state of the work. '.repeat(20)}\nNext step: run the tests.`
const HANDOFF_ENV = { CACHE_KEEPER_HANDOFF: '1', CACHE_KEEPER_HANDOFF_RESTART: 'true' }

/** A transcript in a project dir, with uuid-chained records like Claude Code writes. */
function transcriptIn(home: string, ctx = PRE): string {
  const dir = join(home, 'projects', '-home-user-project')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${SID}.jsonl`)
  const lines = [
    JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, sessionId: SID, cwd: '/home/user/project', version: '2.1.281', message: { role: 'user', content: 'hi' } }),
    assistantLine({ at: T0, read: ctx - 1000, write: 995 }, { uuid: 'a1', parentUuid: 'u1', version: '2.1.281' }),
  ]
  writeFileSync(path, `${lines.join('\n')}\n`)
  return path
}

/**
 * A fake `claude -p --resume`: loads the copy the way Claude Code does — only
 * what follows the last compact_boundary — and answers the verify prompt.
 * `honours: false` plays a CLI that ignores the boundary.
 */
function fakeClaude(transcriptDir: string, honours = true, calls: string[][] = []) {
  return (args: string[]): ClaudeRun => {
    calls.push(args)
    const id = args[args.indexOf('--resume') + 1]
    const lines = readFileSync(join(transcriptDir, `${id}.jsonl`), 'utf8').split('\n').filter(Boolean)
    const cut = lines.findLastIndex((l) => l.includes('"compact_boundary"'))
    const seen = (honours && cut >= 0 ? lines.slice(cut) : lines).join('\n')
    const hid = seen.match(/HANDOFF-ID (H-[0-9a-f]+)/)?.[1] ?? 'NONE'
    const canary = seen.match(/CANARY-[0-9a-f]{8}/)?.[0] ?? 'NONE'
    const ctx = honours ? 40_000 : PRE
    return { status: 0, stdout: JSON.stringify({ result: `${hid} ${canary}`, usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: ctx - 10 } }) }
  }
}

function deps(home: string, transcript: string, o: { honours?: boolean; restartOk?: boolean; onVerify?: () => void } = {}) {
  const restarts: string[] = []
  const claude = fakeClaude(dirname(transcript), o.honours ?? true)
  const d: ApplyDeps = {
    config: configFor(home, HANDOFF_ENV),
    now: () => T0 + 51 * MIN,
    runClaude: (args) => {
      const r = claude(args)
      o.onVerify?.()
      return r
    },
    runRestart: (_cmd, sid) => {
      restarts.push(sid)
      return o.restartOk ?? true
    },
  }
  return { d, restarts }
}

function requested(home: string, transcript: string, summary: string | null = SUMMARY) {
  requestHandoff(home, SID, PRE, transcript, T0 + 50 * MIN)
  if (summary !== null) writeFileSync(summaryPath(home, SID), summary)
}

// --- wake / record ----------------------------------------------------------------

function idleSession(env: Record<string, string>, extra: Partial<ReturnType<typeof newSession>> = {}) {
  const home = tempHome()
  const config = configFor(home, env)
  const transcript = transcriptIn(home)
  saveSession(home, { ...newSession(SID), transcriptPath: transcript, lastTurnEndAt: T0, ctxTokens: PRE, pingsSoFar: T.maxPings, lastPingHit: true, ...extra })
  return { home, config, transcript }
}

test('wake: a spent budget on a warm, large cache asks for a handoff instead of letting it die', () => {
  const { home, config } = idleSession(HANDOFF_ENV)
  const ctx = makeCtx(config, T0 + (T.minAgeSec + 60) * 1000)
  assert.equal(wake({ session_id: SID }, ctx), 2)
  assert.ok(ctx.errors[0].startsWith(WAKE_MARKER), 'the wake prompt must stay recognisable to touch')
  assert.ok(ctx.errors[0].includes(summaryPath(home, SID)))
  const s = loadSession(home, SID)!
  assert.equal(s.pendingPing, true)
  assert.equal(s.handoffPending, true)
  assert.equal(loadRecord(home, SID)!.status, 'requested')
})

test('wake: no handoff when switched off, already asked, cold, small, after a miss, or switched itself off', () => {
  const at = T0 + (T.minAgeSec + 60) * 1000
  const cases: Array<[string, Record<string, string>, object, number?]> = [
    ['off by default', {}, {}],
    ['no restart command', { CACHE_KEEPER_HANDOFF: '1' }, {}],
    ['already asked', HANDOFF_ENV, { handoffRequested: true }],
    ['small context', HANDOFF_ENV, { ctxTokens: 60_000 }],
    ['after an oracle miss', HANDOFF_ENV, { lastPingHit: false }],
    ['cache already cold', HANDOFF_ENV, {}, T0 + T.maxAgeSec * 1000],
  ]
  for (const [name, env, extra, now] of cases) {
    const { config } = idleSession(env, extra)
    assert.equal(wake({ session_id: SID }, makeCtx(config, now ?? at)), 0, name)
  }
  const { home, config } = idleSession(HANDOFF_ENV)
  writeFileSync(join(home, 'handoff-disabled.json'), '{}')
  assert.equal(wake({ session_id: SID }, makeCtx(config, at)), 0, 'switched itself off')
})

test('record: the Stop closing a handoff wake starts the apply step once', () => {
  const { home, config, transcript } = idleSession(HANDOFF_ENV)
  const pingAt = T0 + (T.minAgeSec + 60) * 1000
  wake({ session_id: SID }, makeCtx(config, pingAt))
  appendFileSync(transcript, `${assistantLine({ at: pingAt + 2000, read: PRE, write: 500 })}\n`)
  const started: string[] = []
  const ctx = { ...makeCtx(config, pingAt + 3000), startHandoff: (sid: string) => started.push(sid) }
  record({ session_id: SID, transcript_path: transcript }, ctx)
  record({ session_id: SID, transcript_path: transcript }, ctx)
  assert.deepEqual(started, [SID])
  assert.equal(loadSession(home, SID)!.handoffPending, false)
})

// --- the splice ----------------------------------------------------------------------

test('buildSplice: boundary cuts the chain, the summary hangs off it', () => {
  const home = tempHome()
  const text = readFileSync(transcriptIn(home), 'utf8')
  const [boundary, summary] = buildSplice(text, { sessionId: SID, summary: SUMMARY, handoffId: 'H-1', backupPath: '/b.jsonl', now: T0 }).map((l) => JSON.parse(l))
  assert.equal(boundary.subtype, 'compact_boundary')
  assert.equal(boundary.parentUuid, null)
  assert.equal(boundary.logicalParentUuid, 'a1')
  assert.equal(boundary.version, '2.1.281')
  assert.equal(summary.parentUuid, boundary.uuid)
  assert.equal(summary.isCompactSummary, true)
  assert.ok(summary.message.content.includes('HANDOFF-ID H-1'))
  assert.ok(summary.message.content.includes('/b.jsonl'))
})

// --- apply -----------------------------------------------------------------------------

test('apply: verified on a copy, appended, restarted; the session alone is told', () => {
  const home = tempHome()
  const transcript = transcriptIn(home)
  const before = readFileSync(transcript, 'utf8')
  requested(home, transcript)
  const { d, restarts } = deps(home, transcript)
  const r = applyHandoff(SID, d)
  assert.equal(r.ok, true)
  assert.deepEqual(restarts, [SID])
  const after = readFileSync(transcript, 'utf8')
  assert.ok(after.startsWith(before))
  assert.ok(after.slice(before.length).includes('"compact_boundary"'))
  assert.ok(!after.includes('CANARY-'), 'the canary lives only in the copy')
  const rec = loadRecord(home, SID)!
  assert.equal(rec.status, 'applied')
  assert.equal(readFileSync(rec.backupPath!, 'utf8'), before)
  assert.equal(takeNotices(home, 'other-session', T0 + 52 * MIN).length, 0)
  assert.equal(takeNotices(home, SID, T0 + 52 * MIN).length, 1)
  assert.ok(readLedger(home).some((e) => e.event === 'handoff'))
})

test('apply: no summary on disk — nothing touched, every session told', () => {
  const home = tempHome()
  const transcript = transcriptIn(home)
  const before = readFileSync(transcript, 'utf8')
  requested(home, transcript, null)
  const { d, restarts } = deps(home, transcript)
  assert.deepEqual(applyHandoff(SID, d), { ok: false, failure: 'no-summary', detail: undefined })
  assert.equal(readFileSync(transcript, 'utf8'), before)
  assert.deepEqual(restarts, [])
  assert.match(takeNotices(home, 'any', T0 + 52 * MIN)[0], /rolled back \(no-summary\)/)
  assert.equal(isHandoffDisabled(home), false)
})

test('apply: a CLI that ignores the boundary fails verification — nothing touched, handoff switches off', () => {
  const home = tempHome()
  const transcript = transcriptIn(home)
  const before = readFileSync(transcript, 'utf8')
  requested(home, transcript)
  const { d, restarts } = deps(home, transcript, { honours: false })
  const r = applyHandoff(SID, d)
  assert.equal(r.ok, false)
  assert.equal(!r.ok && r.failure, 'verify-failed')
  assert.equal(readFileSync(transcript, 'utf8'), before)
  assert.deepEqual(restarts, [])
  assert.equal(isHandoffDisabled(home), true)
  assert.match(takeNotices(home, 'any', T0 + 52 * MIN)[0], /handoff-enable/)
  enableHandoff(home)
  assert.equal(isHandoffDisabled(home), false)
})

test('apply: a verify run that never reached the model (auth) rolls back but keeps handoff on', () => {
  const home = tempHome()
  const transcript = transcriptIn(home)
  const before = readFileSync(transcript, 'utf8')
  requested(home, transcript)
  const { d } = deps(home, transcript)
  d.runClaude = () => ({ status: 1, stdout: JSON.stringify({ is_error: true, result: 'Failed to authenticate' }) })
  const r = applyHandoff(SID, d)
  assert.equal(!r.ok && r.failure, 'verify-error')
  assert.equal(readFileSync(transcript, 'utf8'), before)
  assert.equal(isHandoffDisabled(home), false)
  assert.match(takeNotices(home, 'any', T0 + 52 * MIN)[0], /Failed to authenticate/)
})

test('apply: the human came back during verification — nothing touched, nobody bothered', () => {
  const home = tempHome()
  const transcript = transcriptIn(home)
  requested(home, transcript)
  const { d } = deps(home, transcript, { onVerify: () => appendFileSync(transcript, `${assistantLine({ at: T0 + 51 * MIN })}\n`) })
  const r = applyHandoff(SID, d)
  assert.equal(!r.ok && r.failure, 'transcript-changed')
  assert.ok(!readFileSync(transcript, 'utf8').includes('compact_boundary'))
  assert.equal(takeNotices(home, 'any', T0 + 52 * MIN).length, 0)
})

test('apply: a failed restart truncates the transcript back to its old bytes', () => {
  const home = tempHome()
  const transcript = transcriptIn(home)
  const before = readFileSync(transcript, 'utf8')
  requested(home, transcript)
  const { d, restarts } = deps(home, transcript, { restartOk: false })
  const r = applyHandoff(SID, d)
  assert.equal(!r.ok && r.failure, 'restart-failed')
  assert.deepEqual(restarts, [SID])
  assert.equal(readFileSync(transcript, 'utf8'), before)
  assert.equal(isHandoffDisabled(home), false)
})

// --- post-check ------------------------------------------------------------------------

test('postCheck: a smaller context confirms; a full one switches handoff off', () => {
  for (const [ctxTokens, status] of [[45_000, 'checked'], [PRE, 'failed']] as const) {
    const home = tempHome()
    const transcript = transcriptIn(home)
    requested(home, transcript)
    applyHandoff(SID, deps(home, transcript).d)
    takeNotices(home, SID, T0 + 52 * MIN)
    postCheck(home, SID, { ctxTokens, timestamp: T0 + 70 * MIN }, T0 + 70 * MIN)
    assert.equal(loadRecord(home, SID)!.status, status)
    assert.equal(isHandoffDisabled(home), status === 'failed')
  }
})

// --- notices ---------------------------------------------------------------------------

test('notices: once per session, scoped ones only to their sessions, gone after a day', () => {
  const home = tempHome()
  postNotice(home, 'for all', T0)
  postNotice(home, 'for A', T0, ['A'])
  assert.deepEqual(takeNotices(home, 'A', T0 + 1), ['for all', 'for A'])
  assert.deepEqual(takeNotices(home, 'A', T0 + 2), [])
  assert.deepEqual(takeNotices(home, 'B', T0 + 3), ['for all'])
  assert.deepEqual(takeNotices(home, 'C', T0 + NOTICE_TTL_MS + 1), [])
})

test('touch: a real prompt shows pending notices to the human and the model, once', () => {
  const home = tempHome()
  const config = configFor(home)
  postNotice(home, 'cache-keeper: something happened', T0)
  const out: string[] = []
  const ctx = { ...makeCtx(config, T0 + MIN), stdout: (t: string) => out.push(t) }
  touch({ session_id: SID, prompt: 'hello' }, ctx)
  touch({ session_id: SID, prompt: 'again' }, ctx)
  assert.equal(out.length, 1)
  const json = JSON.parse(out[0])
  assert.equal(json.systemMessage, 'cache-keeper: something happened')
  assert.equal(json.hookSpecificOutput.additionalContext, 'cache-keeper: something happened')
  touch({ session_id: 'other', prompt: `${WAKE_MARKER} ping` }, ctx)
  assert.equal(out.length, 1, 'a wake prompt is not a human: no notice')
  assert.ok(existsSync(join(home, 'notices')))
})
