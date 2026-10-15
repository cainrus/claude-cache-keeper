import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { record, touch, wake, WAKE_MARKER } from '../src/commands.ts'
import { briefPath, continuePath, loadRecord, requestHandoff, type HandoffIO } from '../src/handoff.ts'
import { readLedger } from '../src/ledger.ts'
import { postNotice, takeNotices, NOTICE_TTL_MS } from '../src/notices.ts'
import { THRESHOLDS as T } from '../src/policy.ts'
import { loadSession, newSession, saveSession } from '../src/state.ts'
import { assistantLine, configFor, makeCtx, MIN, SID, tempHome } from './helpers.ts'

const T0 = Date.parse('2026-01-01T10:00:00.000Z')
const PRE = 150_000
const BRIEF = `Goal: ship the handoff.\n${'Decisions and state of the work. '.repeat(20)}\nNext step: run the tests.`
const HANDOFF_ENV = { CACHE_KEEPER_HANDOFF: '1' }
const SPAWN_ENV = { ...HANDOFF_ENV, CACHE_KEEPER_HANDOFF_SPAWN: 'start-new' }
const HOUR = 60 * MIN

/** A transcript in a project dir, like Claude Code writes. */
function transcriptIn(home: string, ctx = PRE): string {
  const dir = join(home, 'projects', '-home-user-project')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${SID}.jsonl`)
  const lines = [
    JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, sessionId: SID, cwd: '/home/user/project', message: { role: 'user', content: 'hi' } }),
    assistantLine({ at: T0, read: ctx - 1000, write: 995 }, { uuid: 'a1', parentUuid: 'u1' }),
  ]
  writeFileSync(path, `${lines.join('\n')}\n`)
  return path
}

function idleSession(env: Record<string, string>, extra: Partial<ReturnType<typeof newSession>> = {}) {
  const home = tempHome()
  const config = configFor(home, env)
  const transcript = transcriptIn(home)
  saveSession(home, { ...newSession(SID), transcriptPath: transcript, lastTurnEndAt: T0, ctxTokens: PRE, pingsSoFar: T.maxPings, lastPingHit: true, ...extra })
  return { home, config, transcript }
}

// --- wake / record ----------------------------------------------------------------

test('wake: a spent budget on a warm, large cache asks for a brief instead of letting it die', () => {
  const { home, config } = idleSession(HANDOFF_ENV)
  const ctx = makeCtx(config, T0 + (T.minAgeSec + 60) * 1000)
  assert.equal(wake({ session_id: SID }, ctx), 2)
  assert.ok(ctx.errors[0].startsWith(WAKE_MARKER), 'the wake prompt must stay recognisable to touch')
  assert.ok(ctx.errors[0].includes(briefPath(home, SID)))
  assert.match(ctx.errors[0], /NEW session/)
  const s = loadSession(home, SID)!
  assert.equal(s.pendingPing, true)
  assert.equal(s.handoffPending, true)
  assert.equal(loadRecord(home, SID)!.status, 'requested')
})

test('wake: no handoff when switched off, already asked, cold, small, or after a miss', () => {
  const at = T0 + (T.minAgeSec + 60) * 1000
  const cases: Array<[string, Record<string, string>, object, number?]> = [
    ['off by default', {}, {}],
    ['already asked', HANDOFF_ENV, { handoffRequested: true }],
    ['small context', HANDOFF_ENV, { ctxTokens: 60_000 }],
    ['after an oracle miss', HANDOFF_ENV, { lastPingHit: false }],
    ['cache already cold', HANDOFF_ENV, {}, T0 + T.maxAgeSec * 1000],
  ]
  for (const [name, env, extra, now] of cases) {
    const { config } = idleSession(env, extra)
    assert.equal(wake({ session_id: SID }, makeCtx(config, now ?? at)), 0, name)
  }
})

/** Run the handoff wake and the Stop that closes it, the brief written (or not) in between. */
function handedOff(env: Record<string, string>, brief: string | null = BRIEF) {
  const s = idleSession(env)
  const wakeAt = T0 + 50 * MIN
  assert.equal(wake({ session_id: SID }, makeCtx(s.config, wakeAt)), 2)
  if (brief !== null) writeFileSync(briefPath(s.home, SID), brief)
  writeFileSync(s.transcript, `${readFileSync(s.transcript, 'utf8')}${assistantLine({ at: wakeAt + 5000, read: PRE, write: 900 })}\n`)
  record({ session_id: SID, transcript_path: s.transcript }, makeCtx(s.config, wakeAt + 6000))
  return { ...s, briefAt: wakeAt + 5000 }
}

test('record: the Stop closing a handoff wake marks the brief ready, once; the transcript is untouched', () => {
  const { home, transcript } = handedOff(HANDOFF_ENV)
  const before = readFileSync(transcript, 'utf8')
  const rec = loadRecord(home, SID)!
  assert.equal(rec.status, 'ready')
  assert.equal(loadSession(home, SID)!.handoffPending, false)
  assert.ok(readLedger(home).some((e) => e.event === 'handoff-ready'))
  assert.ok(!before.includes('compact_boundary'))
})

test('record: no brief on disk — failed, and the session alone is told', () => {
  const { home } = handedOff(HANDOFF_ENV, null)
  assert.equal(loadRecord(home, SID)!.status, 'failed')
  assert.equal(takeNotices(home, 'other', T0 + 2 * HOUR).length, 0)
  assert.match(takeNotices(home, SID, T0 + 2 * HOUR)[0], /wrote none/)
})

// --- touch: the menu ------------------------------------------------------------------

interface Out {
  json: any[]
  spawns: Array<{ command: string; env: Record<string, string> }>
  closes: string[]
}

function touchCtx(config: ReturnType<typeof configFor>, now: number, spawnOk = true) {
  const out: Out = { json: [], spawns: [], closes: [] }
  const io: HandoffIO = {
    spawn: (command, env) => {
      out.spawns.push({ command, env })
      return { ok: spawnOk, output: spawnOk ? 'started cc:12345678' : 'key held by a live session' }
    },
    closeLater: (sid) => out.closes.push(sid),
  }
  const ctx = { ...makeCtx(config, now), stdout: (t: string) => out.json.push(JSON.parse(t)), handoffIO: io }
  return { ctx, out }
}

test('touch: back while the cache is still warm — the prompt passes and the brief is retired', () => {
  const { home, config, briefAt } = handedOff(SPAWN_ENV)
  const { ctx, out } = touchCtx(config, briefAt + 30 * MIN)
  touch({ session_id: SID, prompt: 'hello' }, ctx)
  assert.equal(out.json.filter((j) => j.decision === 'block').length, 0)
  assert.equal(loadRecord(home, SID)!.choice, 'warm')
  assert.equal(loadSession(home, SID)!.lastHumanAt, briefAt + 30 * MIN)
})

test('touch: a cold cache with a brief blocks the prompt, shows the menu and changes nothing else', () => {
  const { home, config, briefAt } = handedOff(SPAWN_ENV)
  const now = briefAt + 2 * HOUR
  const { ctx, out } = touchCtx(config, now)
  const before = loadSession(home, SID)!
  touch({ session_id: SID, prompt: 'what next?' }, ctx)
  assert.equal(out.json.length, 1)
  assert.equal(out.json[0].decision, 'block')
  assert.match(out.json[0].reason, /gone cold \(idle 2h 00m\)/)
  assert.match(out.json[0].reason, /~151k tokens \(≈ \$1\.51\)/)
  assert.match(out.json[0].reason, /this session closes/)
  assert.equal(loadRecord(home, SID)!.heldPrompt, 'what next?')
  const after = loadSession(home, SID)!
  assert.equal(after.lastHumanAt, before.lastHumanAt, 'a blocked prompt never ran')
  assert.equal(out.spawns.length, 0)
})

test('touch: the same text again continues here, without extra context', () => {
  const { home, config, briefAt } = handedOff(SPAWN_ENV)
  const { ctx, out } = touchCtx(config, briefAt + 2 * HOUR)
  touch({ session_id: SID, prompt: 'what next?' }, ctx)
  touch({ session_id: SID, prompt: 'what next?\n' }, ctx)
  assert.equal(out.json.length, 1, 'only the menu was printed')
  const rec = loadRecord(home, SID)!
  assert.equal(rec.status, 'used')
  assert.equal(rec.choice, 'here')
  assert.ok(readLedger(home).some((e) => e.event === 'handoff-here'))
})

test('touch: `1` continues here and hands the held message to the model', () => {
  const { config, briefAt } = handedOff(SPAWN_ENV)
  const { ctx, out } = touchCtx(config, briefAt + 2 * HOUR)
  touch({ session_id: SID, prompt: 'what next?' }, ctx)
  touch({ session_id: SID, prompt: '1' }, ctx)
  assert.equal(out.json.length, 2)
  assert.equal(out.json[1].decision, undefined)
  assert.match(out.json[1].hookSpecificOutput.additionalContext, /held while cache-keeper asked[\s\S]*what next\?/)
})

test('touch: any other text replaces the held message and shows the menu again', () => {
  const { home, config, briefAt } = handedOff(SPAWN_ENV)
  const { ctx, out } = touchCtx(config, briefAt + 2 * HOUR)
  touch({ session_id: SID, prompt: 'what next?' }, ctx)
  touch({ session_id: SID, prompt: 'actually, run the tests' }, ctx)
  assert.equal(out.json.filter((j) => j.decision === 'block').length, 2)
  assert.equal(loadRecord(home, SID)!.heldPrompt, 'actually, run the tests')
})

test('touch: `2` spawns a new session from brief + held message, then closes this one', () => {
  const { home, config, briefAt, transcript } = handedOff(SPAWN_ENV)
  const { ctx, out } = touchCtx(config, briefAt + 2 * HOUR)
  touch({ session_id: SID, prompt: 'what next?' }, ctx)
  touch({ session_id: SID, prompt: '2' }, ctx)
  assert.equal(out.spawns.length, 1)
  const { command, env } = out.spawns[0]
  assert.equal(command, 'start-new')
  assert.equal(env.CACHE_KEEPER_BRIEF, continuePath(home, SID))
  assert.equal(env.CACHE_KEEPER_SESSION_ID, SID)
  assert.equal(env.CACHE_KEEPER_TRANSCRIPT_PATH, transcript)
  assert.equal(env.CACHE_KEEPER_CWD, '/home/user/project')
  const brief = readFileSync(env.CACHE_KEEPER_BRIEF, 'utf8')
  assert.ok(brief.startsWith('Goal: ship the handoff.'))
  assert.match(brief, /## The user's message on return\n\nwhat next\?/)
  assert.deepEqual(out.closes, [SID])
  assert.equal(out.json[1].decision, 'block', 'the new session answers, not this one')
  assert.match(out.json[1].reason, /cc:12345678/)
  assert.equal(loadRecord(home, SID)!.choice, 'new')
})

test('touch: a failed spawn keeps this session open and the menu alive', () => {
  const { home, config, briefAt } = handedOff(SPAWN_ENV)
  const { ctx, out } = touchCtx(config, briefAt + 2 * HOUR, false)
  touch({ session_id: SID, prompt: 'what next?' }, ctx)
  touch({ session_id: SID, prompt: '2' }, ctx)
  assert.equal(out.closes.length, 0)
  assert.match(out.json[1].reason, /did not start[\s\S]*key held/)
  const rec = loadRecord(home, SID)!
  assert.equal(rec.status, 'ready')
  assert.equal(rec.heldPrompt, 'what next?')
})

test('touch: without a spawn command, `2` only writes the file and closes nothing', () => {
  const { home, config, briefAt } = handedOff(HANDOFF_ENV)
  const { ctx, out } = touchCtx(config, briefAt + 2 * HOUR)
  touch({ session_id: SID, prompt: 'what next?' }, ctx)
  assert.match(out.json[0].reason, /write the brief plus your message to a file/)
  touch({ session_id: SID, prompt: '2' }, ctx)
  assert.equal(out.spawns.length, 0)
  assert.equal(out.closes.length, 0)
  assert.ok(existsSync(continuePath(home, SID)))
  assert.ok(out.json[1].reason.includes(continuePath(home, SID)))
})

test('touch: closeAfterSpawn off — spawned, not closed', () => {
  const { config, briefAt } = handedOff({ ...SPAWN_ENV, CACHE_KEEPER_HANDOFF_CLOSE: '0' })
  const { ctx, out } = touchCtx(config, briefAt + 2 * HOUR)
  touch({ session_id: SID, prompt: 'what next?' }, ctx)
  touch({ session_id: SID, prompt: '2' }, ctx)
  assert.equal(out.spawns.length, 1)
  assert.equal(out.closes.length, 0)
})

test('touch: a cold cache without a ready brief is not intercepted', () => {
  const home = tempHome()
  const config = configFor(home, SPAWN_ENV)
  saveSession(home, { ...newSession(SID), transcriptPath: transcriptIn(home), lastTurnEndAt: T0, ctxTokens: PRE })
  requestHandoff(home, loadSession(home, SID)!, T0)
  const { ctx, out } = touchCtx(config, T0 + 3 * HOUR)
  touch({ session_id: SID, prompt: 'hello' }, ctx)
  assert.equal(out.json.length, 0)
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
