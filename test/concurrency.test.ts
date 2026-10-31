import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ledgerPath, readLedger } from '../src/ledger.ts'
import { loadSession, newSession, saveSession } from '../src/state.ts'
import { tempHome } from './helpers.ts'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const WRITERS = 8
const LINES = 250

/** Run `body` in `WRITERS` node processes at once; resolves when all exit 0. */
async function race(home: string, body: string): Promise<void> {
  const script = join(home, 'writer.ts')
  writeFileSync(script, body)
  const runs = Array.from({ length: WRITERS }, (_, w) =>
    new Promise<void>((resolve, reject) => {
      const p = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', script, home, String(w)], { stdio: 'inherit' })
      p.on('error', reject)
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${w} exited ${code}`))))
    }),
  )
  await Promise.all(runs)
}

test('ledger: concurrent hooks of many sessions append whole lines and lose none', async () => {
  const home = tempHome()
  await race(
    home,
    `import { appendLedger } from ${JSON.stringify(join(SRC, 'ledger.ts'))}
const [home, w] = process.argv.slice(2)
// A wide line, so a torn write would show up as a line that does not parse.
for (let i = 0; i < ${LINES}; i++) appendLedger(home, { t: new Date().toISOString(), sessionId: 'w' + w, event: 'skip', reason: 'away', detail: 'x'.repeat(600) + i })
`,
  )
  const raw = readFileSync(ledgerPath(home), 'utf8').trimEnd().split('\n')
  assert.equal(raw.length, WRITERS * LINES, 'no line lost or merged')
  const entries = readLedger(home)
  assert.equal(entries.length, WRITERS * LINES, 'every line parses')
  for (let w = 0; w < WRITERS; w++) {
    const mine = entries.filter((e) => e.sessionId === `w${w}`).map((e) => e.detail!.slice(600))
    assert.deepEqual(mine, Array.from({ length: LINES }, (_, i) => String(i)), `writer ${w} kept its order`)
  }
})

test('state: a session file under concurrent rewrites is always whole JSON, never torn', async () => {
  const home = tempHome()
  saveSession(home, newSession('shared'))
  await race(
    home,
    `import { loadSession, saveSession } from ${JSON.stringify(join(SRC, 'state.ts'))}
const [home, w] = process.argv.slice(2)
for (let i = 0; i < ${LINES}; i++) {
  const s = loadSession(home, 'shared')
  if (!s) { console.error('torn or missing read'); process.exit(1) }
  saveSession(home, { ...s, ctxTokens: Number(w) * 1000 + i })
}
`,
  )
  // Lost updates are allowed (documented in state.ts); a half-written file is not.
  const s = loadSession(home, 'shared')
  assert.ok(s, 'the final file parses')
  assert.ok(s.ctxTokens % 1000 === LINES - 1, `the last write of some writer won: ${s.ctxTokens}`)
})
