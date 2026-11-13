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

const STARTUP = '{"session_id":"s1","hook_event_name":"SessionStart","source":"startup"}'

function launch(sub: string, path: string, home = tempHome(), env: Record<string, string> = {}, input = STARTUP) {
  return spawnSync('sh', [LAUNCHER, sub], {
    input,
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

const noteOf = (r: { stdout: string }) => JSON.parse(r.stdout).hookSpecificOutput

test('launcher: the model is asked to offer the setup once per machine for each kind of problem', () => {
  const home = tempHome()
  const first = noteOf(launch('check', pathWith(undefined), home))
  assert.match(first.additionalContext, /AskUserQuestion/)
  assert.equal(first.hookEventName, 'SessionStart')
  // The next session: the person still sees the line, the model is not asked again.
  const second = launch('check', pathWith(undefined), home)
  assert.ok(JSON.parse(second.stdout).systemMessage)
  assert.equal(noteOf(second), undefined)
  // Node 20 appeared since: another kind of problem, asked once more.
  assert.match(noteOf(launch('check', pathWith('v20.1.0'), home)).additionalContext, /found v20\.1\.0/)
  // A minor upgrade within "too old", or Node gone again: both already asked.
  assert.equal(noteOf(launch('check', pathWith('v20.2.0'), home)), undefined)
  assert.equal(noteOf(launch('check', pathWith(undefined), home)), undefined)
})

test('launcher: no note, and no ask spent, outside a fresh interactive start', () => {
  const home = tempHome()
  for (const entry of ['sdk-cli', 'sdk-ts', 'sdk-py']) {
    const r = launch('check', pathWith(undefined), home, { CLAUDE_CODE_ENTRYPOINT: entry })
    assert.ok(JSON.parse(r.stdout).systemMessage, entry)
    assert.equal(noteOf(r), undefined, entry)
  }
  for (const source of ['resume', 'clear', 'compact']) {
    assert.equal(noteOf(launch('check', pathWith(undefined), home, {}, `{"source":"${source}"}`)), undefined, source)
  }
  assert.ok(noteOf(launch('check', pathWith(undefined), home)))
})

test('launcher: keeper turned off keeps check quiet, as src/config.ts reads it', () => {
  for (const off of ['1', 'True', ' YES ', 'on']) {
    const r = launch('check', pathWith(undefined), tempHome(), { CACHE_KEEPER_DISABLED: off })
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '', off)
  }
  const home = tempHome()
  writeFileSync(join(home, 'config.json'), '{\n  "handoff": { "enabled": true },\n  "enabled" : false\n}\n')
  assert.equal(launch('check', pathWith(undefined), home).stdout, '')
  // handoff's own "enabled": false is not keeper's.
  const handoffOff = tempHome()
  writeFileSync(join(handoffOff, 'config.json'), '{"handoff":{"enabled":false,"x":{"y":1}},"enabled":true}')
  assert.ok(JSON.parse(launch('check', pathWith(undefined), handoffOff).stdout).systemMessage)
})

test('launcher: a home that cannot be made still says why, without the note', () => {
  const parent = join(tempHome(), 'a-file')
  writeFileSync(parent, '')
  // A path under a regular file: mkdir fails even for root.
  const r = launch('check', pathWith(undefined), join(parent, 'home'))
  assert.equal(r.status, 0, r.stderr)
  assert.equal(noteOf(r), undefined)
})

test('launcher: stdin, arguments and the exit code pass through to cache-keeper.ts', () => {
  const dir = join(tempHome(), 'fake-bin')
  mkdirSync(dir, { recursive: true })
  const seen = join(dir, 'seen')
  // A node that fits, and that records what it was handed instead of running keeper.
  writeFileSync(
    join(dir, 'node'),
    `#!/bin/sh\n[ "$1" = --version ] && { echo v24.1.0; exit 0; }\nshift 2\necho "$*" > '${seen}.args'\ncat > '${seen}.in'\nexit 2\n`,
  )
  chmodSync(join(dir, 'node'), 0o755)
  const r = launch('wake', `${dir}:${process.env.PATH ?? ''}`, tempHome(), {}, '{"session_id":"s9"}')
  assert.equal(r.status, 2)
  assert.equal(readFileSync(`${seen}.args`, 'utf8'), 'wake\n')
  assert.equal(readFileSync(`${seen}.in`, 'utf8'), '{"session_id":"s9"}')
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
