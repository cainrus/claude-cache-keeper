/**
 * bin/cache-keeper.sh, the shell every hook enters through. With a node that
 * cannot run keeper it stays silent and exits 0 everywhere but `check`, which
 * says why to the person in every session and, once per machine and problem,
 * hands the model a note to offer setting Node up. A fake `node` first on PATH
 * stands in for each version.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildHooks, PLUGIN_SCRIPT } from '../src/hooks.ts'
import { nodeOk } from '../hooks/status.ts'
import { tempHome } from './helpers.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const LAUNCHER = join(ROOT, 'bin/cache-keeper.sh')

/** A PATH whose `node` prints `version` (or fails when it is undefined), then the real PATH. */
function pathWith(version: string | undefined): string {
  const dir = join(tempHome(), 'fake-bin')
  mkdirSync(dir, { recursive: true })
  const body = version === undefined ? 'exit 127' : `echo '${version}'`
  writeFileSync(join(dir, 'node'), `#!/bin/sh\n${body}\n`)
  chmodSync(join(dir, 'node'), 0o755)
  return `${dir}:${process.env.PATH ?? '/usr/bin:/bin'}`
}

function launch(sub: string, path: string, home = tempHome(), env: Record<string, string> = {}) {
  return spawnSync('sh', [LAUNCHER, sub], {
    input: '{}',
    encoding: 'utf8',
    env: { PATH: path, HOME: home, CACHE_KEEPER_HOME: home, ...env },
    timeout: 30_000,
  })
}

const BAD: Array<[string, string | undefined, RegExp]> = [
  ['no node', undefined, /found none$/],
  ['Node 20', 'v20.11.1', /found v20\.11\.1$/],
  ['Node 22.17', 'v22.17.0', /found v22\.17\.0$/],
  ['Node 23.5', 'v23.5.0', /found v23\.5\.0$/],
  ['a node with no version', 'hello', /printed no version$/],
]

for (const [name, version, why] of BAD) {
  test(`launcher, ${name}: check says why, every other hook is silent`, () => {
    const path = pathWith(version)
    const check = launch('check', path)
    assert.equal(check.status, 0, check.stderr)
    const out = JSON.parse(check.stdout)
    assert.match(out.systemMessage.split('. To fix')[0], why)
    for (const sub of ['record', 'touch', 'wake', 'end', 'gate']) {
      const r = launch(sub, path)
      assert.equal(r.status, 0, `${sub}: ${r.stderr}`)
      assert.equal(r.stdout, '', sub)
      assert.equal(r.stderr, '', sub)
    }
  })
}

test('launcher: the model is asked to offer the setup once per machine, again only for a new problem', () => {
  const home = tempHome()
  const first = JSON.parse(launch('check', pathWith(undefined), home).stdout)
  assert.match(first.hookSpecificOutput.additionalContext, /AskUserQuestion/)
  assert.equal(first.hookSpecificOutput.hookEventName, 'SessionStart')
  // The next session: the person still sees the line, the model is not asked again.
  const second = JSON.parse(launch('check', pathWith(undefined), home).stdout)
  assert.ok(second.systemMessage)
  assert.equal(second.hookSpecificOutput, undefined)
  // Node 20 appeared since: a different problem, asked once more.
  const third = JSON.parse(launch('check', pathWith('v20.1.0'), home).stdout)
  assert.match(third.hookSpecificOutput.additionalContext, /found v20\.1\.0/)
})

test('launcher: a headless run gets the line but no note (nobody to ask), and spends no ask', () => {
  const home = tempHome()
  const headless = JSON.parse(launch('check', pathWith(undefined), home, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }).stdout)
  assert.equal(headless.hookSpecificOutput, undefined)
  assert.ok(JSON.parse(launch('check', pathWith(undefined), home).stdout).hookSpecificOutput)
})

test('launcher: CACHE_KEEPER_DISABLED keeps check quiet', () => {
  const r = launch('check', pathWith(undefined), tempHome(), { CACHE_KEEPER_DISABLED: '1' })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
})

test('launcher: an unwritable home still says why, without the note', () => {
  const r = launch('check', pathWith(undefined), '/nonexistent/keeper-home')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput, undefined)
})

test('launcher and hooks/status.ts nodeOk agree on the threshold', () => {
  for (const v of ['v22.17.9', 'v22.18.0', 'v23.0.0', 'v23.5.1', 'v23.6.0', 'v24.0.0', 'v25.2.1', 'v18.20.4']) {
    const silent = launch('check', pathWith(v)).stdout === ''
    assert.equal(silent, nodeOk(v), v)
  }
})

test('launcher, a node keeper can run on: check is silent, the rest reaches cache-keeper.ts', () => {
  assert.ok(nodeOk(process.version), 'the suite itself runs on a supported Node')
  const check = launch('check', process.env.PATH ?? '')
  assert.equal(check.status, 0, check.stderr)
  assert.equal(check.stdout, '')
  const r = launch('--version', process.env.PATH ?? '')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^\d+\.\d+\.\d+\n$/)
})

test('package.json engines names the same floor', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.engines.node, '>=22.18')
})

test('every hook command enters through the launcher', () => {
  for (const groups of Object.values(buildHooks(PLUGIN_SCRIPT).hooks)) {
    for (const { command } of groups[0].hooks) {
      assert.ok(command.includes(`sh ${PLUGIN_SCRIPT} `), command)
      assert.doesNotMatch(command, /\bnode\b/, command)
    }
  }
})
