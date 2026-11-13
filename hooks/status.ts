/**
 * The status line of the plugin: one pinned line under the prompt saying whether
 * keeper is working and until when this session's prompt cache stays warm.
 *
 *   ready                         keeper is on; nothing sent in this session yet
 *   cached till 14:05 · renews ×3 keeper can ping; 3 pings are left in this stretch.
 *                                 Presence is not read here: away past awaySec, no ping
 *   cached till 14:05             no ping is coming (none left, context too small,
 *                                 muted, or a ping missed): 14:05 is final
 *   cache expired                 the cache went cold: the next turn rewrites it
 *   error: needs Node.js ≥ 22.18  the hooks cannot run, so keeper does nothing
 *   (nothing)                     keeper is off or `"statusLine": false`
 *
 * Read from keeper's own files, not the policy: keeper writes
 * `sessions/<id>.json` at every turn end. The record lags a running turn, so
 * the time of each model request this process sends counts too: the first
 * turn shows `cached till` from its first request, not `ready` until it ends.
 * Refreshed on load, at each request, a few seconds after each turn (the
 * Stop hook writes the record then) and every 30 s.
 *
 * A session continued in another one (`/background` writes a `continued-in`
 * entry and the old id ends) starts at `ready` and inherits nothing, until its
 * own first request. Whether that request reads the old cache depends on the
 * setup: on a plain install it read all of it; SessionStart hooks that add
 * context may change the prefix so it reads none, which is why nothing is
 * inherited.
 * Node is checked once on load: the hooks run `.ts` under the user's `node`, and
 * a missing or old one fails without a word.
 *
 * `"statusLine": false` in config.json turns it off, for setups whose own
 * statusLine command already shows keeper.
 * Every failure clears the line: a status must never break a session.
 */

import type { EngineInterface as $ } from 'claude-code'

const EVERY_MS = 30_000
/** The Stop hook writes the record after the turn ends; read it after that. */
const AFTER_TURN_MS = 4_000
const NODE_CHECK_TIMEOUT_MS = 5_000

const DEFAULT_MAX_PINGS = 4
const DEFAULT_MIN_CTX_TOKENS = 20_000
const DEFAULT_TTL_SEC = 3600

export const NODE_ERROR = 'error: needs Node.js ≥ 22.18'

export type Line =
  | { kind: 'ready' }
  | {
      kind: 'cached'
      /** Pings keeper may still send in this stretch. */
      left: number
      /** Whether a ping can still come; false makes the deadline final. */
      extends: boolean
      /** When the cache goes cold if nothing else is sent, ms since the epoch. */
      warmUntil: number
    }
  | { kind: 'expired' }

type Json = Record<string, unknown>

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const envNum = (v: string | undefined): number | undefined => (v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined)
const truthy = (v: string | undefined): boolean => v !== undefined && /^(1|true|yes|on)$/i.test(v)

/** Whether the line is shown at all. */
export function shown(config: Json, env: { disabled?: string }): boolean {
  return config.enabled !== false && config.statusLine !== false && !truthy(env.disabled)
}

/**
 * What to show, or undefined for nothing. Pure, so the tests can drive it.
 * `requestedAt`: this session's last model request seen by the mod, ms since the epoch.
 */
export function lineOf(
  session: Json | undefined,
  config: Json,
  env: { maxPings?: string; minCtxTokens?: string; disabled?: string },
  now: number,
  tuning?: Json,
  requestedAt?: number,
): Line | undefined {
  if (!shown(config, env)) return undefined
  // Confirmed renewals only: `lastTurnEndAt` moves when a turn or a fork ping came back.
  // A ping granted but not back yet is no renewal; once its request goes out, `requestedAt` has it.
  const lastSent = Math.max(num(session?.lastTurnEndAt) ?? 0, requestedAt ?? 0)
  if (lastSent === 0) return { kind: 'ready' }
  const warmUntil = lastSent + (num(config.cacheTtlSec) ?? DEFAULT_TTL_SEC) * 1000
  if (now >= warmUntil) return { kind: 'expired' }
  // As keeper resolves it: env, then config.json, else the cap tune.ts last chose.
  const max = envNum(env.maxPings) ?? num(config.maxPings) ?? num(tuning?.maxPings) ?? DEFAULT_MAX_PINGS
  const left = Math.max(0, max - (num(session?.pingsSoFar) ?? 0))
  // No record yet (the first turn is still running): keeper has nothing to ping from, so no `renews`.
  const bigEnough = (num(session?.ctxTokens) ?? 0) >= (envNum(env.minCtxTokens) ?? num(config.minCtxTokens) ?? DEFAULT_MIN_CTX_TOKENS)
  // Muted by /cache-keeper:done, or by a missed ping: the oracle stops pinging the session for good.
  const muted = session?.doneAt !== undefined || session?.lastPingHit === false
  return { kind: 'cached', left, extends: left > 0 && bigEnough && !muted, warmUntil }
}

export function format(l: Line, offsetMin: number): string {
  if (l.kind === 'ready') return 'ready'
  if (l.kind === 'expired') return 'cache expired'
  const local = new Date(l.warmUntil - offsetMin * 60_000)
  const hhmm = `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`
  return l.extends ? `cached till ${hhmm} · renews ×${l.left}` : `cached till ${hhmm}`
}

/**
 * Whether `node --version` output can run the hooks: `.ts` runs without a flag
 * from 22.18 on the 22 line and from 23.6 on the 23 line.
 */
export function nodeOk(version: string): boolean {
  const m = /^v?(\d+)\.(\d+)\./.exec(version.trim())
  if (!m) return false
  const [major, minor] = [Number(m[1]), Number(m[2])]
  return major >= 24 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18)
}

/** undefined until the check on load has answered. */
let nodeBroken: boolean | undefined

/** The last main-thread model request of this process, with the session it went to (`/clear` changes it). */
let requested: { sid: string; at: number } | undefined

async function checkNode($: $): Promise<void> {
  try {
    const { exitCode, stdout } = await $.process.run(['node', '--version'], { timeoutMs: NODE_CHECK_TIMEOUT_MS })
    nodeBroken = exitCode !== 0 || !nodeOk(stdout)
  } catch {
    // No `node` on PATH at all.
    nodeBroken = true
  }
}

async function readJson($: $, path: string): Promise<Json | undefined> {
  try {
    const v = JSON.parse(await $.fs.read(path))
    return v && typeof v === 'object' ? (v as Json) : undefined
  } catch {
    return undefined
  }
}

async function refresh($: $): Promise<void> {
  try {
    const sid = await $.session.id()
    const home = (await $.env.get('CACHE_KEEPER_HOME')) ?? `${await $.env.get('HOME')}/.claude-cache-keeper`
    if (!/^[A-Za-z0-9_-]+$/.test(sid)) return $.ui.status(undefined)
    const [session, config, tuning] = await Promise.all([
      readJson($, `${home}/sessions/${sid}.json`),
      readJson($, `${home}/config.json`),
      readJson($, `${home}/tuning.json`),
    ])
    const env = {
      maxPings: await $.env.get('CACHE_KEEPER_MAX_PINGS'),
      minCtxTokens: await $.env.get('CACHE_KEEPER_MIN_CTX_TOKENS'),
      disabled: await $.env.get('CACHE_KEEPER_DISABLED'),
    }
    if (nodeBroken) return $.ui.status(shown(config ?? {}, env) ? NODE_ERROR : undefined)
    const now = await $.clock.now()
    const req = requested
    const line = lineOf(session, config ?? {}, env, now, tuning, req?.sid === sid ? req.at : undefined)
    $.ui.status(line === undefined ? undefined : format(line, new Date(line.kind === 'cached' ? line.warmUntil : now).getTimezoneOffset()))
  } catch {
    $.ui.status(undefined)
  }
}

/** Called by gate.ts's `session.start` hook: a plugin has one hooks module, and one hook per event. */
export function statusStarted($: $): void {
  void checkNode($).then(() => refresh($))
  $.clock.every(EVERY_MS, () => refresh($))
}

/** Called by gate.ts's `turn.step` hook as a main-thread request goes out. */
export async function statusRequested($: $): Promise<void> {
  try {
    requested = { sid: await $.session.id(), at: await $.clock.now() }
  } catch {
    return
  }
  await refresh($)
}

/** Called by gate.ts's `turn.complete` hook. */
export function statusTurnDone($: $): void {
  $.clock.after(AFTER_TURN_MS, () => refresh($))
}
