import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseIdleOverride, parseIdleSeconds, readIdleSeconds } from '../src/presence.ts'

const IOREG = `
+-o IOHIDSystem  <class IOHIDSystem, id 0x100000abc, registered, matched, active, busy 0 (0 ms), retain 30>
    {
      "HIDIdleTime" = 125000000000
      "IOClass" = "IOHIDSystem"
    }
`

test('parseIdleSeconds: nanoseconds to whole seconds', () => {
  assert.equal(parseIdleSeconds(IOREG), 125)
  assert.equal(parseIdleSeconds('"HIDIdleTime"=999999999'), 0)
})

test('parseIdleSeconds: missing or garbled key is null, not zero', () => {
  assert.equal(parseIdleSeconds(''), null)
  assert.equal(parseIdleSeconds('"HIDIdleTime" = abc'), null)
  assert.equal(parseIdleSeconds('"IOClass" = "IOHIDSystem"'), null)
})

test('parseIdleOverride', () => {
  assert.equal(parseIdleOverride('42'), 42)
  assert.equal(parseIdleOverride('0'), 0)
  assert.equal(parseIdleOverride('unknown'), null)
  assert.equal(parseIdleOverride(''), null)
  assert.equal(parseIdleOverride('-5'), null)
})

test('readIdleSeconds: env override wins over the probe', () => {
  const exec = () => assert.fail('probe must not run')
  assert.equal(readIdleSeconds({ env: { CACHE_KEEPER_IDLE_SEC: '7' }, platform: 'darwin', exec }), 7)
  assert.equal(readIdleSeconds({ env: { CACHE_KEEPER_IDLE_SEC: 'unknown' }, platform: 'darwin', exec }), null)
})

test('readIdleSeconds: non-macOS is unknown', () => {
  const exec = () => assert.fail('probe must not run')
  assert.equal(readIdleSeconds({ env: {}, platform: 'linux', exec }), null)
})

test('readIdleSeconds: parses ioreg on macOS', () => {
  let called: string[] = []
  const exec = (cmd: string, args: string[]) => {
    called = [cmd, ...args]
    return IOREG
  }
  assert.equal(readIdleSeconds({ env: {}, platform: 'darwin', exec }), 125)
  assert.deepEqual(called.slice(0, 3), ['ioreg', '-c', 'IOHIDSystem'])
})

test('readIdleSeconds: a failing probe is null', () => {
  const exec = () => {
    throw new Error('ioreg: not found')
  }
  assert.equal(readIdleSeconds({ env: {}, platform: 'darwin', exec }), null)
  assert.equal(readIdleSeconds({ env: {}, platform: 'darwin', exec: () => 'garbage' }), null)
})
