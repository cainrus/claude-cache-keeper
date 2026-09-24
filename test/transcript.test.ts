import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { lastMainUsage, usageFromLine } from '../src/transcript.ts'
import { assistantLine, FIXTURES, tempHome } from './helpers.ts'

test('last main-thread usage skips sidechain, synthetic and non-assistant lines', () => {
  const u = lastMainUsage(join(FIXTURES, 'turn.jsonl'))
  assert.deepEqual(u, {
    inputTokens: 6,
    cacheRead: 80_000,
    cacheWrite: 2000,
    outputTokens: 350,
    ctxTokens: 82_006,
    model: 'claude-opus-4-5',
    timestamp: Date.parse('2026-01-01T10:00:30.000Z'),
  })
})

test('missing file and a transcript without usage are undefined', () => {
  assert.equal(lastMainUsage('/nonexistent/transcript.jsonl'), undefined)
  const dir = tempHome()
  const p = join(dir, 'empty.jsonl')
  writeFileSync(p, '{"type":"user","message":{"content":"hi"}}\n')
  assert.equal(lastMainUsage(p), undefined)
})

test('reads past huge trailing lines by widening the window', () => {
  const dir = tempHome()
  const p = join(dir, 'big.jsonl')
  const bigToolResult = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(300_000) } })
  writeFileSync(p, `${assistantLine({ at: 0, read: 42_000 })}\n${bigToolResult}\n${bigToolResult}\n`)
  assert.equal(lastMainUsage(p, 1024)?.cacheRead, 42_000)
})

test('a torn last line is ignored', () => {
  const dir = tempHome()
  const p = join(dir, 'torn.jsonl')
  writeFileSync(p, `${assistantLine({ at: 0, read: 1 })}\n${assistantLine({ at: 1, read: 2 }).slice(0, 80)}`)
  assert.equal(lastMainUsage(p)?.cacheRead, 1)
})

test('usageFromLine: missing fields default to zero', () => {
  const u = usageFromLine(JSON.stringify({ type: 'assistant', message: { usage: { output_tokens: 3 } } }))
  assert.deepEqual(u, { inputTokens: 0, cacheRead: 0, cacheWrite: 0, outputTokens: 3, ctxTokens: 0 })
  assert.equal(usageFromLine('not json "usage"'), undefined)
})
