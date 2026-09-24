import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, THRESHOLD_ENV } from '../src/config.ts'
import { appendLedger, parseLedger, readLedger } from '../src/ledger.ts'
import { THRESHOLDS } from '../src/policy.ts'
import {
  loadAwayBudget,
  loadSession,
  newSession,
  safeId,
  saveAwayBudget,
  saveSession,
  sessionPath,
} from '../src/state.ts'
import { tempHome } from './helpers.ts'

test('session state round-trips and leaves no temp files behind', () => {
  const home = tempHome()
  const s = { ...newSession('abc'), ctxTokens: 123, pingsSoFar: 2 }
  saveSession(home, s)
  assert.deepEqual(loadSession(home, 'abc'), s)
  assert.deepEqual(readdirSync(join(home, 'sessions')), ['abc.json'])
})

test('a corrupt session file reads as absent', () => {
  const home = tempHome()
  saveSession(home, newSession('abc'))
  writeFileSync(sessionPath(home, 'abc'), '{not json')
  assert.equal(loadSession(home, 'abc'), undefined)
})

test('session ids cannot escape the sessions directory', () => {
  assert.equal(safeId('../../etc/passwd'), '__.._etc_passwd')
  assert.equal(safeId(''), '_')
  assert.ok(sessionPath('/h', '../x').startsWith('/h/sessions/'))
})

test('away budget defaults to empty and round-trips', () => {
  const home = tempHome()
  assert.equal(loadAwayBudget(home).awayPingsSincePresence, 0)
  saveAwayBudget(home, { awayPingsSincePresence: 3, updatedAt: 1 })
  assert.equal(loadAwayBudget(home).awayPingsSincePresence, 3)
  writeFileSync(join(home, 'away-budget.json'), '{"awayPingsSincePresence":-4}')
  assert.equal(loadAwayBudget(home).awayPingsSincePresence, 0)
})

test('ledger appends whole lines and skips garbage on read', () => {
  const home = tempHome()
  appendLedger(home, { t: 'x', sessionId: 's', event: 'ping' })
  appendLedger(home, { t: 'y', sessionId: 's', event: 'skip', reason: 'away' })
  assert.equal(readLedger(home).length, 2)
  assert.deepEqual(parseLedger('{"event":"ping","sessionId":"a","t":"t"}\n{torn\n\n{"foo":1}\n').length, 1)
})

test('config: defaults, then config.json, then env', () => {
  const home = tempHome()
  const base = { HOME: '/nonexistent', CACHE_KEEPER_HOME: home }
  assert.deepEqual(loadConfig(base).thresholds, { ...THRESHOLDS })
  assert.equal(loadConfig(base).enabled, true)

  writeFileSync(join(home, 'config.json'), JSON.stringify({ maxPings: 2, minCtxTokens: 'bad', enabled: false, prices: { opus: 15 } }))
  const fromFile = loadConfig(base)
  assert.equal(fromFile.thresholds.maxPings, 2)
  assert.equal(fromFile.thresholds.minCtxTokens, THRESHOLDS.minCtxTokens, 'invalid values are ignored')
  assert.equal(fromFile.enabled, false)
  assert.equal(fromFile.prices.opus, 15)

  const fromEnv = loadConfig({ ...base, [THRESHOLD_ENV.maxPings]: '7', CACHE_KEEPER_DISABLED: '0', CACHE_KEEPER_HIT_RATIO: '0.8' })
  assert.equal(fromEnv.thresholds.maxPings, 7)
  assert.equal(fromEnv.enabled, true)
  assert.equal(fromEnv.hitRatio, 0.8)
})

test('config: home defaults under $HOME, a bad hit ratio falls back', () => {
  const c = loadConfig({ HOME: '/home/user', CACHE_KEEPER_HIT_RATIO: '5' })
  assert.equal(c.home, '/home/user/.claude-cache-keeper')
  assert.equal(c.hitRatio, 0.9)
})
