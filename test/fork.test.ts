import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { end, PING_IN_FLIGHT_MS, record, touch, wake, WAKE_MESSAGE } from '../src/commands.ts'
import {
  arm,
  compactCheck,
  compacted,
  FORK_PROMPT,
  FORK_RETRY_SEC,
  FORK_TIMEOUT_SEC,
  forked,
  forkRetry,
  forkWake,
  type ForkAnswer,
  type ForkResult,
} from '../src/fork.ts'
import { readLedger } from '../src/ledger.ts'
import { THRESHOLDS as T } from '../src/policy.ts'
import { forkClaimPath, loadForkClaim, loadSession, saveForkClaim, saveSession } from '../src/state.ts'
import { configFor, makeCtx, MIN, SID, tempHome, writeTranscript, type TestCtx } from './helpers.ts'

const T0 = Date.parse('2026-01-01T10:00:00.000Z')
const BIG = { read: 90_000, write: 1_000 }
const DUE = (T.minAgeSec + 60) * 1000
const INTERACTIVE = { CLAUDE_CODE_ENTRYPOINT: 'cli' }

type OutCtx = TestCtx & { out: ForkAnswer[] }

function ctxAt(config: ReturnType<typeof configFor>, now: number, idle: number | null = 0): OutCtx {
  const ctx = makeCtx(config, now, idle) as OutCtx
  ctx.out = []
  ctx.stdout = (t) => ctx.out.push(JSON.parse(t))
  return ctx
}

/** A session whose last turn ended at T0 with a large context, as `record` leaves it. */
function setup(env: Record<string, string> = {}) {
  const home = tempHome()
  const config = configFor(home, env)
  const transcript = writeTranscript(home, [{ at: T0, ...BIG }])
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, T0 + 500))
  return { home, config, transcript }
}

function call(fn: (input: any, ctx: any) => number, input: Record<string, unknown>, ctx: OutCtx): ForkAnswer {
  assert.equal(fn({ session_id: SID, ...input }, ctx), 0)
  assert.equal(ctx.out.length, 1, 'one JSON line on stdout')
  return ctx.out[0]
}

const HIT: ForkResult = { isAnswered: true, usage: { input_tokens: 3, cache_read_input_tokens: 91_000, cache_creation_input_tokens: 300, output_tokens: 2 } }
const MISS: ForkResult = { isAnswered: true, usage: { input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 91_000, output_tokens: 2 } }

// --- arm -----------------------------------------------------------------------

test('arm: the mod claims the stretch and the Stop sleeper stands down', () => {
  const { home, config } = setup()
  const a = call((i, c) => arm(i, c, INTERACTIVE), {}, ctxAt(config, T0 + 1000))
  assert.deepEqual(a, { action: 'none', dueInSec: config.delaySec })
  assert.equal(loadForkClaim(home, SID), T0 + 1000)

  const ctx = ctxAt(config, T0 + DUE)
  assert.equal(wake({ session_id: SID }, ctx), 0)
  assert.deepEqual(ctx.errors, [])
  assert.equal(readLedger(home).length, 0)
})

test('arm: forks switched off leave the stretch to the wake turn', () => {
  const { home, config } = setup({ CACHE_KEEPER_FORK: '0' })
  assert.deepEqual(call((i, c) => arm(i, c, INTERACTIVE), {}, ctxAt(config, T0 + 1000)), { action: 'none' })
  assert.equal(loadForkClaim(home, SID), undefined)
  assert.equal(wake({ session_id: SID }, ctxAt(config, T0 + DUE)), 2)
})

test('arm: claude -p is skipped, as the Stop sleeper skips it', () => {
  const { home, config } = setup()
  assert.deepEqual(call((i, c) => arm(i, c, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }), {}, ctxAt(config, T0 + 1000)), { action: 'none' })
  assert.equal(loadForkClaim(home, SID), undefined)
})

test('arm: a session keeper never saw is not claimed', () => {
  const home = tempHome()
  const ctx = ctxAt(configFor(home), T0)
  assert.deepEqual(call((i, c) => arm(i, c, INTERACTIVE), {}, ctx), { action: 'none' })
  assert.equal(loadForkClaim(home, SID), undefined)
})

test('arm: a stale claim from an earlier stretch does not stop the sleeper', () => {
  const { home, config } = setup()
  saveForkClaim(home, SID, T0 - 10 * MIN)
  assert.equal(wake({ session_id: SID }, ctxAt(config, T0 + DUE)), 2)
})

test('arm after a reload: the next ping keeps its time, a lost fork is dropped', () => {
  const { home, config } = setup()
  saveSession(home, { ...loadSession(home, SID)!, pendingPing: true, pingTransport: 'fork', lastPingAt: T0 - 5 * MIN })
  const a = call((i, c) => arm(i, c, INTERACTIVE), { reload: true }, ctxAt(config, T0 + 20 * MIN))
  assert.deepEqual(a, { action: 'none', dueInSec: config.delaySec - 20 * 60 })
  assert.equal(loadSession(home, SID)!.pendingPing, false)
  assert.equal(loadForkClaim(home, SID), T0 + 20 * MIN)
})

test('arm after a reload: an old session (a resume) is not claimed', () => {
  const { home, config } = setup()
  const a = call((i, c) => arm(i, c, INTERACTIVE), { reload: true }, ctxAt(config, T0 + T.maxAgeSec * 1000))
  assert.deepEqual(a, { action: 'none' })
  assert.equal(loadForkClaim(home, SID), undefined)
})

// --- fork-wake -----------------------------------------------------------------

test('fork-wake: pings as a fork, through the same policy and ledger as wake', () => {
  const { home, config } = setup()
  arm({ session_id: SID }, ctxAt(config, T0 + 1000), INTERACTIVE)
  const a = call(forkWake, {}, ctxAt(config, T0 + DUE, 60))
  assert.deepEqual(a, { action: 'fork', prompt: FORK_PROMPT })
  const s = loadSession(home, SID)!
  assert.equal(s.pendingPing, true)
  assert.equal(s.pingTransport, 'fork')
  assert.equal(s.pingsSoFar, 1)
  const [ping] = readLedger(home)
  assert.equal(ping.event, 'ping')
  assert.equal(ping.transport, 'fork')
})

test('fork-wake: too early answers when to ask again', () => {
  const { config } = setup()
  arm({ session_id: SID }, ctxAt(config, T0 + 1000), INTERACTIVE)
  const a = call(forkWake, {}, ctxAt(config, T0 + 40 * MIN))
  assert.deepEqual(a, { action: 'none', dueInSec: T.minAgeSec - 40 * 60 + 1 })
})

test('fork-wake: a stretch the mod did not claim belongs to the sleeper', () => {
  const { home, config } = setup()
  assert.deepEqual(call(forkWake, {}, ctxAt(config, T0 + DUE)), { action: 'none' })
  assert.equal(readLedger(home).length, 0)
})

test('fork-wake: a refusal is logged with its reason, like wake', () => {
  const { home, config } = setup()
  arm({ session_id: SID }, ctxAt(config, T0 + 1000), INTERACTIVE)
  assert.deepEqual(call(forkWake, {}, ctxAt(config, T0 + 59 * MIN)), { action: 'none' })
  assert.equal(readLedger(home)[0].reason, 'cache-expired')
})

test('a ping on its way is not sent twice, by either transport', () => {
  const { home, config } = setup()
  arm({ session_id: SID }, ctxAt(config, T0 + 1000), INTERACTIVE)
  call(forkWake, {}, ctxAt(config, T0 + DUE))
  assert.deepEqual(call(forkWake, {}, ctxAt(config, T0 + DUE + 5_000)), { action: 'none' })
  // Even with the claim gone, the sleeper sees the open fork.
  saveForkClaim(home, SID, T0 - 10 * MIN)
  assert.equal(wake({ session_id: SID }, ctxAt(config, T0 + DUE + 5_000)), 0)
  assert.equal(readLedger(home).filter((e) => e.event === 'ping').length, 1)
  assert.ok(PING_IN_FLIGHT_MS < T.minAgeSec * 1000)
})

// --- forked --------------------------------------------------------------------

test('forked: a read of the prefix is a hit; the next ping is timed from the fork', () => {
  const { home, config } = setup()
  arm({ session_id: SID }, ctxAt(config, T0 + 1000), INTERACTIVE)
  const at = T0 + DUE
  call(forkWake, {}, ctxAt(config, at))
  const a = call(forked, { fork: HIT }, ctxAt(config, at + 4000))
  assert.deepEqual(a, { action: 'none', dueInSec: config.delaySec })
  const s = loadSession(home, SID)!
  assert.equal(s.pendingPing, false)
  assert.equal(s.lastPingHit, true)
  assert.equal(s.lastTurnEndAt, at + 4000)
  assert.equal(s.forkPingsHeld, 1)
  assert.equal(loadForkClaim(home, SID), at + 4000)
  const hit = readLedger(home).at(-1)!
  assert.equal(hit.event, 'wake-hit')
  assert.equal(hit.transport, 'fork')
  assert.equal(hit.cacheRead, 91_000)
  assert.equal(hit.cacheWrite, 300)
})

test('forked: a full rewrite is a miss, which mutes the session as a wake miss does', () => {
  const { home, config } = setup()
  arm({ session_id: SID }, ctxAt(config, T0 + 1000), INTERACTIVE)
  call(forkWake, {}, ctxAt(config, T0 + DUE))
  call(forked, { fork: MISS }, ctxAt(config, T0 + DUE + 4000))
  assert.equal(readLedger(home).at(-1)!.event, 'wake-miss')
  assert.deepEqual(call(forkWake, {}, ctxAt(config, T0 + DUE + 4000 + DUE)), { action: 'none' })
  assert.equal(readLedger(home).at(-1)!.reason, 'oracle-miss')
})

test('forked: a fork with no reply falls back to the wake turn, which record then scores', () => {
  const { home, config, transcript } = setup()
  arm({ session_id: SID }, ctxAt(config, T0 + 1000), INTERACTIVE)
  const at = T0 + DUE
  call(forkWake, {}, ctxAt(config, at))
  const a = call(forked, { fork: { isAnswered: false, reason: 'nothing-to-fork' } }, ctxAt(config, at + 1000))
  assert.deepEqual(a, { action: 'turn', text: WAKE_MESSAGE })
  const failed = readLedger(home).at(-1)!
  assert.equal(failed.event, 'fork-failed')
  assert.equal(failed.failure, 'nothing-to-fork')
  assert.equal(loadSession(home, SID)!.pingTransport, 'turn')

  // The mod submits WAKE_MESSAGE; touch ignores it, the turn's Stop scores it.
  touch({ session_id: SID, prompt: WAKE_MESSAGE }, ctxAt(config, at + 1500))
  writeTranscript(home, [{ at: T0, ...BIG }, { at: at + 3000, read: 91_000, write: 200 }])
  record({ session_id: SID, transcript_path: transcript, stop_hook_active: true }, makeCtx(config, at + 3500))
  assert.equal(readLedger(home).at(-1)!.event, 'wake-hit')
  assert.equal(loadSession(home, SID)!.pendingPing, false)
})

const TIMEOUT: ForkResult = { isAnswered: false, reason: 'timeout' }
const SEC = 1000

test('forked: a timed-out fork is sent again while it can land warm, then falls back to the wake turn', () => {
  const { home, config } = setup()
  arm({ session_id: SID }, ctxAt(config, T0 + 1000), INTERACTIVE)
  call(forkWake, {}, ctxAt(config, T0 + DUE))
  // 53 min: a retry (1 min pause + 2 min fork) still lands under maxAgeSec.
  let t = T0 + DUE + FORK_TIMEOUT_SEC * SEC
  assert.deepEqual(call(forked, { fork: TIMEOUT }, ctxAt(config, t)), { action: 'retry', afterSec: FORK_RETRY_SEC })
  assert.equal(readLedger(home).at(-1)!.next, 'retry')
  assert.equal(loadSession(home, SID)!.forkRetries, 1)

  t += FORK_RETRY_SEC * SEC
  assert.deepEqual(call(forkRetry, {}, ctxAt(config, t)), { action: 'fork', prompt: FORK_PROMPT })
  // 56 min: another retry would land past maxAgeSec, the turn still lands under it.
  t += FORK_TIMEOUT_SEC * SEC
  assert.deepEqual(call(forked, { fork: TIMEOUT }, ctxAt(config, t)), { action: 'turn', text: WAKE_MESSAGE })
  const s = loadSession(home, SID)!
  assert.equal(s.pingTransport, 'turn')
  assert.equal(s.forkRetries, undefined)
  assert.equal(readLedger(home).at(-1)!.next, 'turn')
  assert.equal(readLedger(home).filter((e) => e.event === 'ping').length, 1, 'retries spend no extra ping')
})

test('forked: a fork that fails past maxAgeSec sends nothing, since a request that late rewrites the prefix', () => {
  const { home, config } = setup()
  arm({ session_id: SID }, ctxAt(config, T0 + 1000), INTERACTIVE)
  call(forkWake, {}, ctxAt(config, T0 + DUE))
  const late = T0 + T.maxAgeSec * SEC
  assert.deepEqual(call(forked, { fork: TIMEOUT }, ctxAt(config, late)), { action: 'none' })
  const e = readLedger(home).at(-1)!
  assert.equal(e.event, 'fork-failed')
  assert.equal(e.next, 'drop')
  const s = loadSession(home, SID)!
  assert.equal(s.pendingPing, false)
  assert.equal(s.pingTransport, 'fork')
})

test('forked: a final failure (nothing-to-fork) skips the retry', () => {
  const { config } = setup()
  arm({ session_id: SID }, ctxAt(config, T0 + 1000), INTERACTIVE)
  call(forkWake, {}, ctxAt(config, T0 + DUE))
  const a = call(forked, { fork: { isAnswered: false, reason: 'nothing-to-fork' } }, ctxAt(config, T0 + DUE + SEC))
  assert.equal(a.action, 'turn')
})

test('fork-retry: a real prompt during the pause takes the stretch, no fork goes out', () => {
  const { home, config } = setup()
  arm({ session_id: SID }, ctxAt(config, T0 + 1000), INTERACTIVE)
  call(forkWake, {}, ctxAt(config, T0 + DUE))
  const t = T0 + DUE + FORK_TIMEOUT_SEC * SEC
  call(forked, { fork: TIMEOUT }, ctxAt(config, t))
  touch({ session_id: SID, prompt: 'hi' }, ctxAt(config, t + 10 * SEC))
  assert.deepEqual(call(forkRetry, {}, ctxAt(config, t + FORK_RETRY_SEC * SEC)), { action: 'none' })
  assert.equal(loadSession(home, SID)!.pendingPing, false)
})

test('fork-retry: nothing open answers none', () => {
  const { config } = setup()
  assert.deepEqual(call(forkRetry, {}, ctxAt(config, T0 + DUE)), { action: 'none' })
})

test('forked: nothing open to score answers none and logs nothing', () => {
  const { home, config } = setup()
  assert.deepEqual(call(forked, { fork: HIT }, ctxAt(config, T0 + DUE)), { action: 'none' })
  assert.equal(readLedger(home).length, 0)
})

test('record: a Stop never scores an open fork', () => {
  const { home, config, transcript } = setup()
  arm({ session_id: SID }, ctxAt(config, T0 + 1000), INTERACTIVE)
  call(forkWake, {}, ctxAt(config, T0 + DUE))
  record({ session_id: SID, transcript_path: transcript, stop_hook_active: true }, makeCtx(config, T0 + DUE + 100))
  assert.equal(loadSession(home, SID)!.pendingPing, true)
  assert.equal(readLedger(home).filter((e) => e.event.startsWith('wake-')).length, 0)
})

test('loop: forks every ~50 min while hits land, stop at the per-stretch budget', () => {
  const { home, config } = setup()
  arm({ session_id: SID }, ctxAt(config, T0 + 1000), INTERACTIVE)
  let t = T0
  const actions: string[] = []
  for (let i = 0; i < T.maxPings + 1; i++) {
    t += DUE
    const a = call(forkWake, {}, ctxAt(config, t, 60))
    actions.push(a.action)
    if (a.action !== 'fork') break
    t += 3000
    call(forked, { fork: HIT }, ctxAt(config, t))
  }
  assert.deepEqual(actions, [...Array(T.maxPings).fill('fork'), 'none'])
  assert.equal(readLedger(home).filter((e) => e.event === 'wake-hit').length, T.maxPings)
  assert.equal(readLedger(home).at(-1)?.reason, 'budget-spent')
})

// --- compact-check (anthropics/claude-code#105017) -----------------------------

/** Forks alone held the cache since the last turn, which ended at T0. */
function heldByForks() {
  const s = setup()
  arm({ session_id: SID }, ctxAt(s.config, T0 + 1000), INTERACTIVE)
  let t = T0
  for (let i = 0; i < 2; i++) {
    t += DUE
    call(forkWake, {}, ctxAt(s.config, t))
    t += 3000
    call(forked, { fork: HIT }, ctxAt(s.config, t))
  }
  return { ...s, lastFork: t }
}

test('compact-check: after forks held the cache past the TTL, one wake turn goes first', () => {
  const { home, config, lastFork } = heldByForks()
  const a = call(compactCheck, { trigger: 'manual' }, ctxAt(config, lastFork + 5 * MIN))
  assert.deepEqual(a, { action: 'renew', text: WAKE_MESSAGE })
  const renew = readLedger(home).at(-1)!
  assert.equal(renew.event, 'renew')
  assert.equal(renew.pings, 2)
})

test('compact-check: a turn since the forks puts Claude Code back in step', () => {
  const { config, transcript, lastFork } = heldByForks()
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, lastFork + MIN))
  assert.deepEqual(call(compactCheck, { trigger: 'manual' }, ctxAt(config, lastFork + 2 * MIN)), { action: 'pass' })
})

test('compact-check: passes a cold cache, an auto compaction and a stretch without forks', () => {
  const { config, lastFork } = heldByForks()
  assert.deepEqual(call(compactCheck, { trigger: 'manual' }, ctxAt(config, lastFork + 61 * MIN)), { action: 'pass' })
  assert.deepEqual(call(compactCheck, { trigger: 'auto' }, ctxAt(config, lastFork + MIN)), { action: 'pass' })
  const fresh = setup()
  assert.deepEqual(call(compactCheck, { trigger: 'manual' }, ctxAt(fresh.config, T0 + 59 * MIN)), { action: 'pass' })
})

test('compact-check: within the TTL of the last real turn Claude Code still trusts its cache', () => {
  const { config } = setup()
  arm({ session_id: SID }, ctxAt(config, T0 + 1000), INTERACTIVE)
  call(forkWake, {}, ctxAt(config, T0 + DUE))
  call(forked, { fork: HIT }, ctxAt(config, T0 + DUE + 3000))
  assert.deepEqual(call(compactCheck, { trigger: 'plugin' }, ctxAt(config, T0 + DUE + 4000)), { action: 'pass' })
})

// --- after a compaction --------------------------------------------------------

test('compacted: nothing is pinged until the next turn, by either transport', () => {
  const { home, config, transcript } = setup()
  arm({ session_id: SID }, ctxAt(config, T0 + 1000), INTERACTIVE)
  call(compacted, {}, ctxAt(config, T0 + 2 * MIN))

  assert.deepEqual(call(forkWake, {}, ctxAt(config, T0 + DUE)), { action: 'none' })
  const skip = readLedger(home).at(-1)!
  assert.equal(skip.event, 'skip')
  assert.equal(skip.reason, 'compacted')
  assert.equal(loadSession(home, SID)!.pingsSoFar, 0)
  saveForkClaim(home, SID, T0 - 10 * MIN)
  assert.equal(wake({ session_id: SID }, ctxAt(config, T0 + DUE)), 0)

  // The next turn sends the compacted prefix itself: pings hold it from then on.
  writeTranscript(home, [{ at: T0, ...BIG }, { at: T0 + 10 * MIN, read: 27_000, write: 42_000 }])
  touch({ session_id: SID, prompt: 'go on' }, ctxAt(config, T0 + 10 * MIN - 5000))
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, T0 + 10 * MIN + 500))
  arm({ session_id: SID }, ctxAt(config, T0 + 10 * MIN + 600), INTERACTIVE)
  assert.equal(call(forkWake, {}, ctxAt(config, T0 + 10 * MIN + DUE)).action, 'fork')
})

test('compacted: a compaction before the last turn changes nothing', () => {
  const home = tempHome()
  const config = configFor(home)
  const transcript = writeTranscript(home, [{ at: T0, ...BIG }])
  record({ session_id: SID, transcript_path: transcript }, makeCtx(config, T0 + 500))
  call(compacted, {}, ctxAt(config, T0 - MIN))
  arm({ session_id: SID }, ctxAt(config, T0 + 1000), INTERACTIVE)
  assert.equal(call(forkWake, {}, ctxAt(config, T0 + DUE)).action, 'fork')
})

test('forked: input sent uncached counts against the hit (measured after /compact: 42k input, 27k read)', () => {
  const { home, config } = setup()
  arm({ session_id: SID }, ctxAt(config, T0 + 1000), INTERACTIVE)
  call(forkWake, {}, ctxAt(config, T0 + DUE))
  const fork = { isAnswered: true, usage: { input_tokens: 42_164, cache_read_input_tokens: 26_833, cache_creation_input_tokens: 1_432, output_tokens: 4 } }
  call(forked, { fork }, ctxAt(config, T0 + DUE + 4000))
  assert.equal(readLedger(home).at(-1)!.event, 'wake-miss')
})

// --- end -------------------------------------------------------------------------

test('end: drops the claim with the session', () => {
  const { home, config } = setup()
  arm({ session_id: SID }, ctxAt(config, T0 + 1000), INTERACTIVE)
  end({ session_id: SID }, makeCtx(config, T0 + 2000))
  assert.equal(existsSync(forkClaimPath(home, SID)), false)
})
