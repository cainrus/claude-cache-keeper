import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claudeAncestor, type PsLine } from '../src/handoff-run.ts'

/** A process table: pid -> `ppid comm`, the shape `ps -o ppid=,comm=` prints. */
function table(rows: Record<number, string>): PsLine {
  return pid => rows[pid]
}

// Process names as measured on macOS, Claude Code 2.1.303.
const DAEMON = '/Users/u/.local/bin/claude'

test('claudeAncestor: an interactive session is the nearest `claude`', () => {
  const ps = table({ 30: '20 /bin/sh', 20: '10 claude', 10: '1 -zsh' })
  assert.equal(claudeAncestor(30, ps), 20)
})

test('claudeAncestor: a background session is `claude bg-spare`, not the daemon above it', () => {
  const ps = table({
    40: '30 /bin/sh',
    30: '20 claude bg-spare',
    20: '10 claude bg-pty-host',
    10: `1 ${DAEMON}`,
  })
  assert.equal(claudeAncestor(40, ps), 30)
})

test('claudeAncestor: past a pty host it stops instead of reaching the daemon', () => {
  const ps = table({ 40: '20 /bin/sh', 20: '10 claude bg-pty-host', 10: `1 ${DAEMON}` })
  assert.equal(claudeAncestor(40, ps), undefined)
})

test('claudeAncestor: a vanished process gives no pid', () => {
  assert.equal(claudeAncestor(40, table({ 40: '30 /bin/sh' })), undefined)
})
