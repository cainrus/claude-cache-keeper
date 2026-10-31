import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LINUX_PROBES,
  linuxIdleSeconds,
  parseBareInt,
  parseGdbusUint,
  parseIdleOverride,
  parseIdleSeconds,
  parseLoginctlUser,
  readIdleSeconds,
  type Exec,
} from '../src/presence.ts'

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

test('readIdleSeconds: a platform without a probe is unknown', () => {
  const exec = () => assert.fail('probe must not run')
  assert.equal(readIdleSeconds({ env: {}, platform: 'win32', exec }), null)
  assert.equal(readIdleSeconds({ env: {}, platform: 'freebsd', exec }), null)
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

// --- Linux -------------------------------------------------------------------

const NOW = Date.parse('2026-03-01T10:00:00.000Z')

/** A fake system: each command's output, or an Error to throw (missing binary, no bus). */
function system(outputs: Record<string, string | Error>): Exec & { calls: string[] } {
  const calls: string[] = []
  const exec = ((cmd: string, args: string[]) => {
    const key = cmd === 'gdbus' ? `gdbus ${args[3]}` : cmd
    calls.push(key)
    const out = outputs[key] ?? new Error(`${cmd}: not found`)
    if (out instanceof Error) throw out
    return out
  }) as Exec & { calls: string[] }
  exec.calls = calls
  return exec
}

const MUTTER = 'gdbus org.gnome.Mutter.IdleMonitor'
const SCREENSAVER = 'gdbus org.freedesktop.ScreenSaver'

test('parseGdbusUint: the number of a gdbus tuple, null for anything else', () => {
  assert.equal(parseGdbusUint('(uint64 12345,)\n'), 12345)
  assert.equal(parseGdbusUint('(uint32 7,)'), 7)
  assert.equal(parseGdbusUint('(uint32 7)'), 7)
  assert.equal(parseGdbusUint("Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown"), null)
  assert.equal(parseGdbusUint('(int32 -1,)'), null)
  assert.equal(parseGdbusUint(''), null)
})

test('parseBareInt: xprintidle output only', () => {
  assert.equal(parseBareInt('4200\n'), 4200)
  assert.equal(parseBareInt("couldn't open display"), null)
  assert.equal(parseBareInt('12 34'), null)
})

test('parseLoginctlUser: idle since the hint, 0 while not idle', () => {
  const sinceUs = (NOW - 600_000) * 1000
  assert.equal(parseLoginctlUser(`Display=2\nIdleHint=yes\nIdleSinceHint=${sinceUs}\n`, NOW), 600)
  assert.equal(parseLoginctlUser('Display=2\nIdleHint=no\nIdleSinceHint=0\n', NOW), 0)
})

test('parseLoginctlUser: without a graphical session the hint is not trusted', () => {
  // A headless box never sets IdleHint; "no" there would read as "at the keyboard".
  assert.equal(parseLoginctlUser('Display=\nIdleHint=no\nIdleSinceHint=0\n', NOW), null)
  assert.equal(parseLoginctlUser('IdleHint=no\n', NOW), null)
})

test('parseLoginctlUser: garbled or impossible values are null', () => {
  assert.equal(parseLoginctlUser('Display=2\nIdleHint=maybe\n', NOW), null)
  assert.equal(parseLoginctlUser('Display=2\nIdleHint=yes\nIdleSinceHint=0\n', NOW), null)
  assert.equal(parseLoginctlUser('Display=2\nIdleHint=yes\nIdleSinceHint=abc\n', NOW), null)
  assert.equal(parseLoginctlUser(`Display=2\nIdleHint=yes\nIdleSinceHint=${(NOW + 60_000) * 1000}\n`, NOW), 0, 'a clock skew is not negative idle')
})

test('linux: Mutter answers first, in seconds, and nothing else is asked', () => {
  const exec = system({ [MUTTER]: '(uint64 125000,)' })
  assert.equal(linuxIdleSeconds(exec, NOW, 1000), 125)
  assert.deepEqual(exec.calls, [MUTTER])
})

test('linux: each missing probe falls through to the next, in order', () => {
  const sinceUs = (NOW - 90_000) * 1000
  const exec = system({ loginctl: `Display=c2\nIdleHint=yes\nIdleSinceHint=${sinceUs}` })
  assert.equal(linuxIdleSeconds(exec, NOW, 1000), 90)
  assert.deepEqual(exec.calls, LINUX_PROBES.map((p) => (p.cmd === 'gdbus' ? `gdbus ${p.args(0)[3]}` : p.cmd)))
})

test('linux: the freedesktop ScreenSaver interface reports seconds', () => {
  assert.equal(linuxIdleSeconds(system({ [SCREENSAVER]: '(uint32 42,)' }), NOW, 1000), 42)
})

test('linux: xprintidle reports milliseconds', () => {
  assert.equal(linuxIdleSeconds(system({ xprintidle: '61500\n' }), NOW, 1000), 61)
})

test('linux: an answer that does not parse falls through instead of winning', () => {
  const exec = system({ [MUTTER]: 'Error: no such object', xprintidle: '3000' })
  assert.equal(linuxIdleSeconds(exec, NOW, 1000), 3)
})

test('linux: nothing answering is unknown, never zero', () => {
  assert.equal(linuxIdleSeconds(system({}), NOW, 1000), null)
  assert.equal(linuxIdleSeconds(system({ loginctl: 'Display=\nIdleHint=no' }), NOW, 1000), null)
})

test('linux: logind is asked about the given uid', () => {
  let seen: string[] = []
  const exec: Exec = (cmd, args) => {
    if (cmd !== 'loginctl') throw new Error('missing')
    seen = args
    return 'Display=2\nIdleHint=no'
  }
  assert.equal(linuxIdleSeconds(exec, NOW, 1234), 0)
  assert.deepEqual(seen.slice(0, 2), ['show-user', '1234'])
})

test('readIdleSeconds: routes linux to the probe chain, with the given clock', () => {
  const exec = system({ xprintidle: '10000' })
  assert.equal(readIdleSeconds({ env: {}, platform: 'linux', exec, now: NOW, uid: 1000 }), 10)
  assert.equal(readIdleSeconds({ env: { CACHE_KEEPER_IDLE_SEC: '5' }, platform: 'linux', exec: () => assert.fail('no probe') }), 5)
})

test('readIdleSeconds: the real probe of this machine answers a number or null, quickly', () => {
  // Runs the actual ioreg / Linux chain of whatever OS the suite is on (CI: macOS and Ubuntu).
  const started = Date.now()
  const v = readIdleSeconds({ env: {} })
  assert.ok(v === null || (Number.isInteger(v) && v >= 0), `got ${v}`)
  assert.ok(Date.now() - started < 10_000, 'four probes at 2 s each at most')
})
