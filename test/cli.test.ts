/**
 * End to end: the exact commands from hooks/hooks.json, run through bash the
 * way Claude Code runs them, with hook input on stdin, a temp state dir, a fake
 * transcript and a presence override. No Claude Code, no network, any OS.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WAKE_MESSAGE } from '../src/commands.ts'
import { buildHooks, PLUGIN_SCRIPT } from '../src/hooks.ts'
import { readLedger } from '../src/ledger.ts'
import { THRESHOLDS as T } from '../src/policy.ts'
import { sessionPath } from '../src/state.ts'
import { SID, tempHome, writeTranscript } from './helpers.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const hooksJson = JSON.parse(readFileSync(join(ROOT, 'hooks/hooks.json'), 'utf8'))

function command(event: 'Stop' | 'UserPromptSubmit' | 'SessionEnd', index = 0): string {
  return (hooksJson.hooks[event][0].hooks[index].command as string).replaceAll('${CLAUDE_PLUGIN_ROOT}', ROOT)
}

interface Run {
  status: number | null
  stdout: string
  stderr: string
  ms: number
}

function run(cmd: string, input: unknown, env: Record<string, string>): Run {
  const started = Date.now()
  const r = spawnSync('bash', ['-c', cmd], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    // A clean env: the suite may itself run inside a Claude Code session.
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: env.CACHE_KEEPER_HOME, ...env },
    timeout: 30_000,
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - started }
}

function fresh() {
  const home = tempHome()
  const env = { CACHE_KEEPER_HOME: home, CACHE_KEEPER_IDLE_SEC: '30', CACHE_KEEPER_DELAY_SEC: '0' }
  // The last turn ended just past minAgeSec ago, so a wake right now is due.
  const transcript = writeTranscript(home, [{ at: Date.now() - (T.minAgeSec + 60) * 1000, read: 90_000, write: 500 }])
  const stop = { session_id: SID, transcript_path: transcript, hook_event_name: 'Stop', stop_hook_active: false }
  return { home, env, transcript, stop }
}

test('hooks/hooks.json is exactly what the generator produces', () => {
  assert.deepEqual(hooksJson, buildHooks(PLUGIN_SCRIPT))
  const waiter = hooksJson.hooks.Stop[0].hooks[1]
  assert.equal(waiter.asyncRewake, true)
  assert.match(waiter.command, /^\[ "\$CLAUDE_CODE_ENTRYPOINT" = sdk-cli \] \|\| \{ sleep "\$\{CACHE_KEEPER_DELAY_SEC:-3000\}"; /)
})

test('manifests agree with package.json', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const plugin = JSON.parse(readFileSync(join(ROOT, '.claude-plugin/plugin.json'), 'utf8'))
  const market = JSON.parse(readFileSync(join(ROOT, '.claude-plugin/marketplace.json'), 'utf8'))
  assert.equal(plugin.version, pkg.version)
  assert.equal(market.plugins[0].name, plugin.name)
  assert.equal(market.plugins[0].version, pkg.version)
})

test('e2e: record -> wait+wake pings -> wake turn scored -> human returns -> report -> end', () => {
  const { home, env, stop } = fresh()

  const rec = run(command('Stop', 0), stop, env)
  assert.equal(rec.status, 0, rec.stderr)
  assert.equal(rec.stdout, '')

  // The waiter: sleep 0, then wake. Exit 2 with exactly the wake message —
  // any Node warning here would be read by the model.
  const w = run(command('Stop', 1), stop, env)
  assert.equal(w.status, 2)
  assert.equal(w.stderr, `${WAKE_MESSAGE}\n`)
  assert.deepEqual(readLedger(home).map((e) => e.event), ['ping'])

  // The wake turn's own UserPromptSubmit is ignored.
  const wakePrompt = run(command('UserPromptSubmit'), { session_id: SID, prompt: `Stop hook feedback:\n${WAKE_MESSAGE}` }, env)
  assert.equal(wakePrompt.status, 0)
  assert.equal(wakePrompt.stdout, '', 'UserPromptSubmit stdout would be injected into the context')

  // The Stop closing the wake turn: scored as a hit from the wake turn's own
  // entry, which is necessarily newer than the ping that caused it.
  const wakeTurn = writeTranscript(home, [{ at: Date.now(), read: 90_400, write: 900 }], 'wake-turn.jsonl')
  const closing = run(command('Stop', 0), { ...stop, transcript_path: wakeTurn, stop_hook_active: true }, env)
  assert.equal(closing.status, 0)

  const human = run(command('UserPromptSubmit'), { session_id: SID, prompt: 'continue' }, env)
  assert.equal(human.status, 0)
  assert.equal(human.stdout, '')
  assert.deepEqual(readLedger(home).map((e) => e.event), ['ping', 'wake-hit', 'resume'])

  const report = run(`node ${JSON.stringify(join(ROOT, 'bin/cache-keeper.ts'))} report --json`, '', env)
  assert.equal(report.status, 0, report.stderr)
  const summary = JSON.parse(report.stdout)
  assert.equal(summary.pings, 1)
  assert.equal(summary.hits, 1)
  assert.equal(summary.resumedAfterPing, 1)

  assert.ok(existsSync(sessionPath(home, SID)))
  assert.equal(run(command('SessionEnd'), { session_id: SID, reason: 'exit' }, env).status, 0)
  assert.ok(!existsSync(sessionPath(home, SID)))
})

test('e2e: a refusal exits 0 and says nothing to the model', () => {
  const { home, env, stop } = fresh()
  run(command('Stop', 0), stop, env)
  const w = run(command('Stop', 1), stop, { ...env, CACHE_KEEPER_IDLE_SEC: String(T.awaySec + 1) })
  assert.equal(w.status, 0)
  assert.equal(w.stderr, '')
  assert.equal(readLedger(home)[0].reason, 'away')
})

test('e2e: a stale sleeper exits 0 without a ledger line', () => {
  const { home, env, stop } = fresh()
  const recent = writeTranscript(home, [{ at: Date.now(), read: 90_000 }], 'recent.jsonl')
  run(command('Stop', 0), { ...stop, transcript_path: recent }, env)
  const w = run(command('Stop', 1), stop, env)
  assert.equal(w.status, 0)
  assert.equal(w.stderr, '')
  assert.deepEqual(readLedger(home), [])
})

test('e2e: under `claude -p` (sdk-cli) the waiter returns at once instead of sleeping', () => {
  const { env, stop } = fresh()
  const w = run(command('Stop', 1), stop, { ...env, CACHE_KEEPER_DELAY_SEC: '20', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' })
  assert.equal(w.status, 0)
  assert.ok(w.ms < 10_000, `took ${w.ms} ms`)
})

test('e2e: the delay reaches sleep from the environment', () => {
  const { env, stop } = fresh()
  run(command('Stop', 0), stop, env)
  const w = run(command('Stop', 1), stop, { ...env, CACHE_KEEPER_DELAY_SEC: '1' })
  assert.equal(w.status, 2)
  assert.ok(w.ms >= 1000, `took ${w.ms} ms`)
})

test('e2e: garbage on stdin never fails a hook', () => {
  const { env } = fresh()
  for (const sub of ['record', 'wake', 'touch', 'end']) {
    const r = run(`node ${JSON.stringify(join(ROOT, 'bin/cache-keeper.ts'))} ${sub}`, '{not json', env)
    assert.equal(r.status, 0, `${sub}: ${r.stderr}`)
    assert.equal(r.stdout, '')
  }
})

test('cli: --help, --version, install-snippet, unknown command', () => {
  const env = { CACHE_KEEPER_HOME: tempHome() }
  const bin = `node ${JSON.stringify(join(ROOT, 'bin/cache-keeper.ts'))}`
  assert.match(run(`${bin} --help`, '', env).stdout, /record/)
  assert.match(run(`${bin} --version`, '', env).stdout, /^\d+\.\d+\.\d+\n$/)
  const snippet = JSON.parse(run(`${bin} install-snippet`, '', env).stdout)
  assert.equal(snippet.hooks.Stop[0].hooks[1].asyncRewake, true)
  assert.ok(snippet.hooks.Stop[0].hooks[1].command.includes(join(ROOT, 'bin/cache-keeper.ts')))
  assert.equal(run(`${bin} nope`, '', env).status, 64)
})
