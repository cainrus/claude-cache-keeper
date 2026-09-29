import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runSkipIf } from '../src/veto.ts'
import { SID, tempHome } from './helpers.ts'

const facts = { sessionId: SID, transcriptPath: '/t/x.jsonl', lastPromptAt: Date.parse('2026-01-01T10:00:00.000Z') }

test('skipIf: exit 0 vetoes the ping, any other exit lets it through', () => {
  assert.equal(runSkipIf('exit 0', facts), true)
  assert.equal(runSkipIf('exit 1', facts), false)
  assert.equal(runSkipIf('exit 7', facts), false)
})

test('skipIf: a command that cannot run or hangs never vetoes — the ping goes out as before', () => {
  assert.equal(runSkipIf('/nonexistent/probe', facts), false)
  assert.equal(runSkipIf('sleep 5', facts, 200), false)
})

test('skipIf: the session facts reach the command as env vars', () => {
  const out = join(tempHome(), 'env.txt')
  runSkipIf(`printf '%s|%s|%s' "$CACHE_KEEPER_SESSION_ID" "$CACHE_KEEPER_TRANSCRIPT_PATH" "$CACHE_KEEPER_LAST_PROMPT_AT" > '${out}'`, facts)
  assert.equal(readFileSync(out, 'utf8'), `${SID}|/t/x.jsonl|2026-01-01T10:00:00.000Z`)
})

test('skipIf: unknown facts arrive as empty strings, not "undefined"', () => {
  const out = join(tempHome(), 'env.txt')
  runSkipIf(`printf '%s|%s' "$CACHE_KEEPER_TRANSCRIPT_PATH" "$CACHE_KEEPER_LAST_PROMPT_AT" > '${out}'`, { sessionId: SID })
  assert.equal(readFileSync(out, 'utf8'), '|')
})
