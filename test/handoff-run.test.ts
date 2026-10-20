import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claudeAncestor, type ReadPsLine } from '../src/handoff-run.ts'

/** A process table: pid -> `ppid comm`, the shape `ps -o ppid=,comm=` prints. */
function table(rows: Record<number, string>): ReadPsLine {
  return pid => rows[pid]
}

// Process names as measured on macOS, Claude Code 2.1.303-2.1.304.
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

test('claudeAncestor: an unknown claude title (a renamed bg-spare) gives no pid, not the daemon', () => {
  const ps = table({
    40: '30 /bin/sh',
    30: '20 claude bg-worker',
    20: '10 claude bg-pty-host',
    10: `1 ${DAEMON}`,
  })
  assert.equal(claudeAncestor(40, ps), undefined)
})

test('claudeAncestor: an interactive session titled by its versioned binary counts', () => {
  const ps = table({ 30: '20 /bin/sh', 20: '10 /Users/u/.local/share/claude/versions/2.1.304', 10: '1 -zsh' })
  assert.equal(claudeAncestor(30, ps), 20)
})

test('claudeAncestor: a hook straight under the daemon gives no pid', () => {
  const ps = table({ 30: '20 /bin/sh', 20: `1 ${DAEMON}` })
  assert.equal(claudeAncestor(30, ps), undefined)
})

test('claudeAncestor: any other claude title stops the walk with no pid', () => {
  for (const title of ['/Applications/ClaudeCode.app/Contents/MacOS/claude', '/opt/homebrew/bin/claude']) {
    const ps = table({ 30: '20 /bin/sh', 20: `10 ${title}`, 10: '1 claude' })
    assert.equal(claudeAncestor(30, ps), undefined, title)
  }
})

test('claudeAncestor: a vanished process gives no pid', () => {
  assert.equal(claudeAncestor(40, table({ 40: '30 /bin/sh' })), undefined)
})
