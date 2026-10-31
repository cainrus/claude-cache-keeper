import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tempHome } from './helpers.ts'

/**
 * Claude Code's own validator over the plugin and the marketplace manifest:
 * catches schema drift that our "manifests agree" tests cannot see. Needs a
 * `claude` binary (`CLAUDE_BIN`, else `claude` on PATH; CI installs a pinned
 * one) and is skipped without it, so `npm test` stays dependency-free.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CLAUDE = process.env.CLAUDE_BIN ?? 'claude'

function claude(args: string[]) {
  // An empty config dir: the validator must not depend on whoever runs the suite.
  return spawnSync(CLAUDE, args, { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CLAUDE_CONFIG_DIR: tempHome() } })
}

const available = claude(['--version']).status === 0
// The CI job that installs Claude Code sets this, so a broken install fails instead of skipping.
const required = process.env.CACHE_KEEPER_REQUIRE_CLAUDE === '1'
const skip = available || required ? false : `no Claude Code binary (${CLAUDE}); set CLAUDE_BIN to run it`

test('a Claude Code binary is there when the run requires one', { skip: !required }, () => {
  assert.ok(available, `${CLAUDE} --version failed`)
})

test('claude plugin validate --strict: the plugin, its hooks, module and commands', { skip }, () => {
  const r = claude(['plugin', 'validate', '--strict', ROOT])
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  assert.match(r.stdout, /Validation passed/)
})

test('claude plugin validate --strict: the marketplace manifest', { skip }, () => {
  const r = claude(['plugin', 'validate', '--strict', `${ROOT}.claude-plugin/marketplace.json`])
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
})
