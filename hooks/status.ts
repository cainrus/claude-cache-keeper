/**
 * The status line of the plugin: one pinned line under the prompt saying until
 * when this session's prompt cache stays warm and whether keeper will extend it.
 *
 *   cache ↻³ 14:05   keeper will ping; ³ pings are left in this stretch
 *   cache → 14:05    no ping is coming (none left, context too small, muted):
 *                    14:05 is final
 *   (nothing)        the cache is cold, keeper is off, or it has no record yet
 *
 * Read from keeper's own files, not the policy: a mod has no Node, and keeper
 * writes `sessions/<id>.json` at every turn end. Refreshed on load, a few seconds
 * after each turn (the Stop hook writes the record then) and every 30 s, so the
 * line goes away by itself once the cache is cold.
 *
 * `"statusLine": false` in config.json turns it off, for setups whose own
 * statusLine command already shows keeper.
 * Every failure clears the line: a status must never break a session.
 */

const EVERY_MS = 30_000
/** The Stop hook writes the record after the turn ends; read it after that. */
const AFTER_TURN_MS = 4_000

const DEFAULT_MAX_PINGS = 4
const DEFAULT_MIN_CTX_TOKENS = 20_000
const DEFAULT_TTL_SEC = 3600

const SUPERSCRIPT = '⁰¹²³⁴⁵⁶⁷⁸⁹'

export interface Line {
  /** Pings keeper may still send in this stretch. */
  left: number
  /** Whether a ping can still come; false makes the deadline final. */
  extends: boolean
  /** When the cache goes cold if nothing else is sent, ms since the epoch. */
  warmUntil: number
}

type Json = Record<string, unknown>

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const envNum = (v: string | undefined): number | undefined => (v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined)
const truthy = (v: string | undefined): boolean => v !== undefined && /^(1|true|yes|on)$/i.test(v)

/** What to show, or undefined for nothing. Pure, so the tests can drive it. */
export function lineOf(session: Json | undefined, config: Json, env: { maxPings?: string; minCtxTokens?: string; disabled?: string }, now: number, tuning?: Json): Line | undefined {
  if (session === undefined) return undefined
  if (config.enabled === false || config.statusLine === false || truthy(env.disabled)) return undefined
  const lastSent = Math.max(num(session.lastTurnEndAt) ?? 0, num(session.lastPingAt) ?? 0)
  if (lastSent === 0) return undefined
  const warmUntil = lastSent + (num(config.cacheTtlSec) ?? DEFAULT_TTL_SEC) * 1000
  if (now >= warmUntil) return undefined
  // As keeper resolves it: env, then config.json, else the cap tune.ts last chose.
  const max = envNum(env.maxPings) ?? num(config.maxPings) ?? num(tuning?.maxPings) ?? DEFAULT_MAX_PINGS
  const left = Math.max(0, max - (num(session.pingsSoFar) ?? 0))
  const bigEnough = (num(session.ctxTokens) ?? 0) >= (envNum(env.minCtxTokens) ?? num(config.minCtxTokens) ?? DEFAULT_MIN_CTX_TOKENS)
  const muted = session.doneAt !== undefined
  return { left, extends: left > 0 && bigEnough && !muted, warmUntil }
}

export function format(l: Line, offsetMin: number): string {
  const local = new Date(l.warmUntil - offsetMin * 60_000)
  const hhmm = `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`
  if (!l.extends) return `cache → ${hhmm}`
  const sup = [...String(l.left)].map(d => SUPERSCRIPT[Number(d)]).join('')
  return `cache ↻${sup} ${hhmm}`
}

async function readJson($, path: string): Promise<Json | undefined> {
  try {
    const v = JSON.parse(await $.fs.read(path))
    return v && typeof v === 'object' ? (v as Json) : undefined
  } catch {
    return undefined
  }
}

async function refresh($): Promise<void> {
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
    const now = await $.clock.now()
    const line = lineOf(session, config ?? {}, env, now, tuning)
    $.ui.status(line === undefined ? undefined : format(line, new Date(line.warmUntil).getTimezoneOffset()))
  } catch {
    $.ui.status(undefined)
  }
}

/** Called by gate.ts's `session.start` hook: a plugin has one hooks module, and one hook per event. */
export function statusStarted($): void {
  void refresh($)
  $.clock.every(EVERY_MS, () => refresh($))
}

/** Called by gate.ts's `turn.complete` hook. */
export function statusTurnDone($): void {
  $.clock.after(AFTER_TURN_MS, () => refresh($))
}
