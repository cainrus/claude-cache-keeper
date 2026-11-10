import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WAKE_MARKER, WAKE_MESSAGE } from '../src/commands.ts'
import { FORK_PROMPT } from '../src/fork.ts'
import { handoffMessage } from '../src/handoff.ts'
import { WAKE_REPLY } from '../src/wake-text.ts'

const cases: Array<[kind: string, text: string]> = [
  ['ping', WAKE_MESSAGE],
  ['handoff', handoffMessage(WAKE_MARKER, '/tmp/brief.md')],
]

for (const [kind, text] of cases) {
  test(`${kind} wake ends with the shared reply instruction`, () => {
    assert.ok(text.endsWith(WAKE_REPLY), text)
  })

  test(`${kind} wake joins its sentences with a space`, () => {
    assert.doesNotMatch(text, /[.:;][A-Z]/)
  })

  test(`${kind} wake does not demand a bare "ok"`, () => {
    assert.doesNotMatch(text, /reply with exactly "ok"/i)
  })
}

test('the reply instruction says the wake is not a stop and asks to name the wait', () => {
  assert.match(WAKE_REPLY, /not a stop/i)
  assert.match(WAKE_REPLY, /waiting for <what>/)
  assert.match(WAKE_REPLY, /no further tools/i)
})

test('the fork ping keeps a bare "ok": its answer never reaches the transcript', () => {
  assert.ok(!FORK_PROMPT.includes(WAKE_REPLY), FORK_PROMPT)
  assert.match(FORK_PROMPT, /reply with exactly "ok"/i)
})

test('the ping stays one line', () => {
  assert.doesNotMatch(WAKE_MESSAGE, /\n/)
})
