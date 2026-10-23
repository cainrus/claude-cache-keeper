/**
 * A background session nobody is watching: the cold-cache menu must not swallow a peer
 * message or a task notification there (workflow-3477). Nobody presses Enter in such a
 * session, so a held message froze it until the sender happened to resend the same text.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gate, record, touch, wake } from '../src/commands.ts'
import { briefPath, isMachineMessage, loadRecord, type HandoffIO } from '../src/handoff.ts'
import { readLedger } from '../src/ledger.ts'
import { takeNotices } from '../src/notices.ts'
import { THRESHOLDS as T } from '../src/policy.ts'
import { isBackgroundSession } from '../src/presence.ts'
import { loadSession, newSession, saveSession } from '../src/state.ts'
import { assistantLine, configFor, makeCtx, MIN, SID, tempHome } from './helpers.ts'

const T0 = Date.parse('2026-01-01T10:00:00.000Z')
const PRE = 150_000
const HOUR = 60 * MIN
const BRIEF = `Goal: ship it.\n${'Decisions and state of the work. '.repeat(20)}\nNext step: run the tests.`
const SPAWN_ENV = { CACHE_KEEPER_HANDOFF: '1', CACHE_KEEPER_HANDOFF_SPAWN: 'start-new' }

const PEER =
  '<cross-session-message from="uds:/tmp/cc-socks/76200.sock" from-name="night lead" from-mode="prompting">\n' +
  'continue: your reviewer finished at 05:01\n</cross-session-message>'
const TASK =
  '<task-notification>\n<task-id>acb206664a8174067</task-id>\n<status>completed</status>\n' +
  '<summary>Agent "Fresh correctness review" completed</summary>\n</task-notification>'

/** A session with a ready brief and a cold cache; `back` touches it two hours later. */
function coldWithBrief(background: boolean, holder?: 'handoff' | 'ping') {
  const home = tempHome()
  const config = configFor(home, SPAWN_ENV)
  const dir = join(home, 'projects', '-home-user-project')
  mkdirSync(dir, { recursive: true })
  const transcript = join(dir, `${SID}.jsonl`)
  writeFileSync(transcript, `${assistantLine({ at: T0, read: PRE - 1000, write: 995 })}\n`)
  saveSession(home, { ...newSession(SID), transcriptPath: transcript, lastTurnEndAt: T0, ctxTokens: PRE, pingsSoFar: T.maxPings, lastPingHit: true })
  const wakeAt = T0 + 50 * MIN
  const w = makeCtx(config, wakeAt)
  if (holder) w.skipIf = () => 'handoff'
  assert.equal(wake({ session_id: SID }, w), 2)
  writeFileSync(briefPath(home, SID), BRIEF)
  writeFileSync(transcript, `${readFileSync(transcript, 'utf8')}${assistantLine({ at: wakeAt + 5000, read: PRE, write: 900 })}\n`)
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, wakeAt + 6000))
  assert.equal(loadRecord(home, SID)!.status, 'ready')

  const out = { json: [] as any[], spawns: 0, closes: 0 }
  const io: HandoffIO = {
    spawn: () => {
      out.spawns++
      return { ok: true, output: 'started' }
    },
    closeLater: () => {
      out.closes++
    },
  }
  const back = { ...makeCtx(config, wakeAt + 2 * HOUR), stdout: (t: string) => out.json.push(JSON.parse(t)), handoffIO: io, background: () => background }
  if (holder) back.skipIf = () => holder
  return { home, back, out, now: wakeAt + 2 * HOUR }
}

const blocks = (out: { json: any[] }) => out.json.filter((j) => j.decision === 'block')

test('touch: in a background session a peer message into a cold cache passes, and the brief is retired', () => {
  const { home, back, out, now } = coldWithBrief(true)
  touch({ session_id: SID, prompt: PEER }, back)
  assert.equal(blocks(out).length, 0, 'not held')
  const rec = loadRecord(home, SID)!
  assert.equal(rec.status, 'used')
  assert.equal(rec.choice, 'here')
  assert.equal(loadSession(home, SID)!.lastHumanAt, now, 'the turn ran')
  const here = readLedger(home).filter((e) => e.event === 'handoff-here')
  assert.equal(here.length, 1)
  assert.equal(here[0].detail, 'unattended')
})

test('touch: in a background session a task notification passes too', () => {
  const { home, back, out } = coldWithBrief(true)
  touch({ session_id: SID, prompt: TASK }, back)
  assert.equal(blocks(out).length, 0)
  assert.equal(loadRecord(home, SID)!.choice, 'here')
})

test('gate: a task notification starting a turn in a background session passes in silence', () => {
  const { home, back, out } = coldWithBrief(true)
  gate({ session_id: SID, prompt: TASK, gate_turn: true }, back)
  assert.equal(out.json.length, 0, 'nothing printed: the request goes')
  assert.equal(loadRecord(home, SID)!.choice, 'here')
  assert.equal(loadSession(home, SID)!.gateTurnAt, undefined, 'its Stop is an ordinary one')
})

test('touch: in a background session an ordinary prompt still gets the menu', () => {
  const { home, back, out } = coldWithBrief(true)
  touch({ session_id: SID, prompt: 'what next?' }, back)
  assert.equal(blocks(out).length, 1)
  assert.match(blocks(out)[0].reason, /gone cold/)
  assert.equal(loadRecord(home, SID)!.status, 'ready')
})

test('touch: an interactive session keeps the gate for peer messages and task notifications', () => {
  for (const prompt of [PEER, TASK]) {
    const { home, back, out } = coldWithBrief(false)
    touch({ session_id: SID, prompt }, back)
    assert.equal(blocks(out).length, 1, prompt.slice(0, 20))
    assert.equal(loadRecord(home, SID)!.heldPrompt, prompt)
  }
})

test('touch: a message held before (old behaviour) reaches the model with the peer message that passes', () => {
  const { back, out } = coldWithBrief(true)
  touch({ session_id: SID, prompt: 'what next?' }, back)
  assert.equal(blocks(out).length, 1)
  touch({ session_id: SID, prompt: PEER }, back)
  assert.equal(blocks(out).length, 1, 'the peer message was not held')
  const ctx = out.json[1].hookSpecificOutput.additionalContext
  assert.match(ctx, /held by cache-keeper[\s\S]*what next\?/)
})

test('gate: a message held before is left as a notice when a gate turn passes (a gate cannot add context)', () => {
  const { home, back, out, now } = coldWithBrief(true)
  touch({ session_id: SID, prompt: 'what next?' }, back)
  gate({ session_id: SID, prompt: TASK, gate_turn: true }, back)
  assert.equal(out.json.length, 1, 'only the first menu')
  const notes = takeNotices(home, SID, now + MIN)
  assert.equal(notes.length, 1)
  assert.match(notes[0], /what next\?/)
})

test('touch: a peer message into a held background session continues there, it is not handed off', () => {
  const { home, back, out } = coldWithBrief(true, 'handoff')
  assert.equal(loadRecord(home, SID)!.auto, true)
  touch({ session_id: SID, prompt: PEER }, back)
  assert.equal(blocks(out).length, 0)
  assert.equal(out.spawns, 0, 'the sender would be left talking to a closed session')
  assert.equal(out.closes, 0)
  assert.equal(loadRecord(home, SID)!.choice, 'here')
})

test('touch: a warm cache is unchanged in a background session', () => {
  const { home, back, out } = coldWithBrief(true)
  touch({ session_id: SID, prompt: PEER }, { ...back, now: back.now - 90 * MIN })
  assert.equal(blocks(out).length, 0)
  assert.equal(loadRecord(home, SID)!.choice, 'warm')
})

test('isMachineMessage: peer messages and task notifications only, as the prompt carries them', () => {
  assert.equal(isMachineMessage(PEER), true)
  assert.equal(isMachineMessage(`\n  ${TASK}`), true)
  assert.equal(isMachineMessage(`Another Claude session sent a message:\n${PEER}`), true)
  assert.equal(isMachineMessage('what next?'), false)
  assert.equal(isMachineMessage('look at this: <task-notification>x</task-notification>'), false)
  assert.equal(isMachineMessage('<cross-session-messages>'), false)
  assert.equal(isMachineMessage(''), false)
})

test('isBackgroundSession: the job dir of a background session, else the transcript, else no', () => {
  const dir = tempHome()
  const bg = join(dir, 'bg.jsonl')
  writeFileSync(bg, `${JSON.stringify({ type: 'user', sessionKind: 'bg' })}\n${JSON.stringify({ type: 'last-prompt' })}\n`)
  const fg = join(dir, 'fg.jsonl')
  writeFileSync(fg, `${JSON.stringify({ type: 'user', entrypoint: 'cli' })}\n`)

  assert.equal(isBackgroundSession({ CLAUDE_JOB_DIR: '/x/jobs/ddd059b1' }), true)
  assert.equal(isBackgroundSession({}, bg), true)
  assert.equal(isBackgroundSession({}, fg), false)
  assert.equal(isBackgroundSession({}, join(dir, 'missing.jsonl')), false)
  assert.equal(isBackgroundSession({ CLAUDE_JOB_DIR: '' }), false)
  assert.equal(isBackgroundSession({ CLAUDE_JOB_DIR: '/x', CACHE_KEEPER_BACKGROUND: '0' }), false, 'override off')
  assert.equal(isBackgroundSession({ CACHE_KEEPER_BACKGROUND: '1' }, fg), true, 'override on')
})
