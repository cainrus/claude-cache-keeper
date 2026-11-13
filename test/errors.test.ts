import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { record, touch } from '../src/commands.ts'
import { ERROR_NOTICE_EVERY_MS, errorLogPath, recordError } from '../src/errors.ts'
import { readLedger } from '../src/ledger.ts'
import { formatReport, summarize } from '../src/report.ts'
import { DEFAULT_PRICES } from '../src/prices.ts'
import { loadSession, newSession, saveSession } from '../src/state.ts'
import { statusReport } from '../src/inspect.ts'
import { errorLine } from '../hooks/status.ts'
import { assistantLine, configFor, makeCtx, MIN, SID, tempHome, writeTranscript } from './helpers.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const T0 = Date.parse('2026-01-01T10:00:00.000Z')

test('recordError: a log line, a ledger event, the session marked, and one notice an hour', () => {
  const home = tempHome()
  saveSession(home, newSession(SID))
  recordError(home, 'record', SID, new Error('boom\nsecond line'), T0)
  const log = readFileSync(errorLogPath(home), 'utf8')
  assert.match(log, /^2026-01-01T10:00:00\.000Z record 0{8}-0{4}-4000-8000-00000000abcd boom second line/)
  assert.deepEqual(readLedger(home).map((e) => [e.event, e.detail]), [['error', 'record: boom second line']])
  const s = loadSession(home, SID)!
  assert.deepEqual(s.lastError, { at: T0, cmd: 'record', message: 'boom second line' })
  assert.equal(s.errorNoticeAt, T0)

  // Within the hour: logged and marked again, but no second notice.
  recordError(home, 'touch', SID, new Error('again'), T0 + 10 * MIN)
  assert.equal(loadSession(home, SID)!.errorNoticeAt, T0)
  assert.equal(loadSession(home, SID)!.lastError?.cmd, 'touch')
  recordError(home, 'touch', SID, new Error('later'), T0 + ERROR_NOTICE_EVERY_MS)
  assert.equal(loadSession(home, SID)!.errorNoticeAt, T0 + ERROR_NOTICE_EVERY_MS)
})

test('recordError: no session id, or a home it cannot write, still never throws', () => {
  const home = tempHome()
  recordError(home, 'wake', undefined, 'plain string', T0)
  assert.equal(readLedger(home)[0].sessionId, '-')
  const file = join(tempHome(), 'a-file')
  writeFileSync(file, '')
  assert.doesNotThrow(() => recordError(join(file, 'home'), 'wake', SID, new Error('x'), T0))
})

test('the session hears of it on its next prompt, and the status says so until a clean turn', () => {
  const home = tempHome()
  const config = configFor(home)
  const transcript = writeTranscript(home, [{ at: T0, read: 90_000, write: 500 }])
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, T0 + 1000))
  recordError(home, 'wake', SID, new Error('ENOENT'), T0 + 2000)

  const out: string[] = []
  touch({ session_id: SID, prompt: 'next' }, { ...makeCtx(config, T0 + 3000), stdout: (t: string) => out.push(t) })
  assert.match(JSON.parse(out[0]).systemMessage, /the wake hook failed \(ENOENT\)\. Log: .*errors\.log/)
  assert.match(statusReport(loadSession(home, SID), config, {}, T0 + 3000), /error: the wake hook failed at \d\d:\d\d: ENOENT/)
  assert.equal(errorLine(loadSession(home, SID) as never, home), `error: wake failed · ${home}/errors.log`)

  // The next turn recorded end to end clears it.
  writeFileSync(transcript, `${assistantLine({ at: T0 + 4000, read: 90_000, write: 200 })}\n`, { flag: 'a' })
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, T0 + 5000))
  assert.equal(loadSession(home, SID)!.lastError, undefined)
  assert.equal(errorLine(loadSession(home, SID) as never, home), undefined)
})

test('report counts errors by hook', () => {
  const t = new Date(T0).toISOString()
  const s = summarize(
    [
      { t, sessionId: 'a', event: 'error', detail: 'record: x' },
      { t, sessionId: 'a', event: 'error', detail: 'record: y' },
      { t, sessionId: 'b', event: 'error', detail: 'wake: z' },
    ],
    { prices: DEFAULT_PRICES, cacheTtlSec: 3600, hitRatio: 0.9 },
  )
  assert.deepEqual(s.errors, { record: 2, wake: 1 })
  assert.match(formatReport(s), /hook errors \(see errors\.log\)\n\s+record\s+2\n\s+wake\s+1/)
})

test('cli: a hook that throws exits 0 and leaves the trace', () => {
  const home = tempHome()
  // A file where the sessions directory should be: saving the session throws.
  writeFileSync(join(home, 'sessions'), '')
  const transcript = writeTranscript(home, [{ at: Date.now() - 1000, read: 90_000, write: 500 }])
  const r = spawnSync(process.execPath, [join(ROOT, 'bin/cache-keeper.ts'), 'record'], {
    input: JSON.stringify({ session_id: SID, transcript_path: transcript }),
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: home, CACHE_KEEPER_HOME: home },
  })
  assert.equal(r.status, 0)
  assert.ok(existsSync(errorLogPath(home)), r.stderr)
  assert.match(readFileSync(errorLogPath(home), 'utf8'), / record 0{8}-/)
  assert.equal(readLedger(home).at(-1)?.event, 'error')
})
