/**
 * `/cache-keeper:status`: what keeper thinks of this session and which
 * settings are in force, with where each came from. Answered by the
 * UserPromptSubmit hook, so it costs no model request.
 *
 * The sources follow `loadConfig`'s order (env, then config.json, then the
 * default) and use its parsers, so a value the loader would ignore (a typo, a
 * negative number) reads as not set here too.
 */

import { bool, num, readConfigFile, str, THRESHOLD_ENV, type Config } from './config.ts'
import { hhmm, NOTHING_TO_HOLD, shortTokens } from './format.ts'
import { THRESHOLDS, type Thresholds } from './policy.ts'
import { compactedSinceRequest, forkOwns, warmUntilOf, type SessionState } from './state.ts'
import { loadTuning } from './tune.ts'

/** Where a setting's value came from; `tuned` is the cap tune.ts chose. */
export type Source = 'env' | 'config.json' | 'default' | 'tuned'

/** One row of the report's settings table. */
export interface Setting {
  key: string
  value: string
  source: Source
}

type Raw = Record<string, unknown>

/** Long commands (`skipIf`, `handoff.spawnCommand`) are cut to keep one line per setting. */
const MAX_VALUE_CHARS = 60

function show(v: unknown): string {
  const s = v === undefined ? '-' : String(v)
  return s.length > MAX_VALUE_CHARS ? `${s.slice(0, MAX_VALUE_CHARS - 1)}…` : s
}

function sourceOf(parse: (v: unknown) => unknown, envValue: unknown, fileValue: unknown): Source {
  if (envValue !== undefined && parse(envValue) !== undefined) return 'env'
  if (parse(fileValue) !== undefined) return 'config.json'
  return 'default'
}

function ratio(v: unknown): number | undefined {
  const n = num(v)
  return n !== undefined && n <= 1 ? n : undefined
}

function isRecord(v: unknown): v is Raw {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** The per-stretch cap keeper uses now. Read-only: unlike `tunedMaxPings`, it never recomputes. */
export function effectiveMaxPings(config: Config): { value: number; source: 'tuned' | undefined } {
  if (!config.maxPingsAuto) return { value: config.thresholds.maxPings, source: undefined }
  const tuned = loadTuning(config.home)?.maxPings
  return tuned === undefined ? { value: config.thresholds.maxPings, source: undefined } : { value: tuned, source: 'tuned' }
}

/** Every setting keeper reads, its value in force and where that value came from. */
export function settingsOf(config: Config, env: NodeJS.ProcessEnv, cap = effectiveMaxPings(config)): Setting[] {
  const file = readConfigFile(config.home)
  const handoff = isRecord(file.handoff) ? file.handoff : {}
  const rows: Setting[] = []
  const add = (key: string, value: unknown, source: Source) => rows.push({ key, value: show(value), source })

  add('enabled', config.enabled, sourceOf(bool, env.CACHE_KEEPER_DISABLED, file.enabled))
  for (const key of Object.keys(THRESHOLDS) as Array<keyof Thresholds>) {
    const fromEnvOrFile = sourceOf(num, env[THRESHOLD_ENV[key]], file[key])
    if (key === 'maxPings') add(key, cap.value, cap.source ?? fromEnvOrFile)
    else add(key, config.thresholds[key], fromEnvOrFile)
  }
  add('hitRatio', config.hitRatio, sourceOf(ratio, env.CACHE_KEEPER_HIT_RATIO, file.hitRatio))
  add('cacheTtlSec', config.cacheTtlSec, sourceOf(num, undefined, file.cacheTtlSec))
  add('delaySec', config.delaySec, sourceOf(num, env.CACHE_KEEPER_DELAY_SEC, undefined))
  add('forkPings', config.forkPings, sourceOf(bool, env.CACHE_KEEPER_FORK, file.forkPings))
  // Read by the mod (hooks/status.ts), not by loadConfig: only `false` turns it off.
  add('statusLine', file.statusLine !== false, file.statusLine === false ? 'config.json' : 'default')
  add('skipIf', config.skipIf, sourceOf(str, env.CACHE_KEEPER_SKIP_IF, file.skipIf))
  add('handoff.enabled', config.handoff.enabled, sourceOf(bool, env.CACHE_KEEPER_HANDOFF, handoff.enabled))
  add('handoff.minCtxTokens', config.handoff.minCtxTokens, sourceOf(num, env.CACHE_KEEPER_HANDOFF_MIN_CTX_TOKENS, handoff.minCtxTokens))
  add('handoff.spawnCommand', config.handoff.spawnCommand, sourceOf(str, env.CACHE_KEEPER_HANDOFF_SPAWN, handoff.spawnCommand))
  add('handoff.closeAfterSpawn', config.handoff.closeAfterSpawn, sourceOf(bool, env.CACHE_KEEPER_HANDOFF_CLOSE, handoff.closeAfterSpawn))
  return rows
}

/** What keeper knows of this session, one `label: value` line each. */
export function sessionLines(state: SessionState | undefined, config: Config, now: number, maxPings: number): string[] {
  if (!config.enabled) return ['keeper is off (enabled: false): nothing is pinged']
  const warmUntil = warmUntilOf(state, config.cacheTtlSec)
  if (state === undefined || warmUntil === undefined) return [`ready: ${NOTHING_TO_HOLD.noTurn}`]

  const lines: string[] = []
  if (now < warmUntil) {
    const renewedAt = warmUntil - config.cacheTtlSec * 1000
    lines.push(`cache: cached till ${hhmm(warmUntil)} (last renewed ${hhmm(renewedAt)})`)
  } else {
    lines.push(`cache: ${NOTHING_TO_HOLD.expired(warmUntil)}`)
  }
  lines.push(`pings this idle stretch: ${state.pingsSoFar} of ${maxPings}`)

  const min = config.thresholds.minCtxTokens
  let context = `context: ${shortTokens(state.ctxTokens)} tokens`
  if (state.ctxTokens < min) context += `, under minCtxTokens (${shortTokens(min)}): not held`
  lines.push(context)

  const transport = forkOwns(state, config) ? 'forks (nothing lands in the transcript)' : 'wake turns'
  lines.push(`pings are sent as: ${transport}`)
  if (state.lastPingHit !== null) lines.push(`last ping: ${state.lastPingHit ? 'hit' : 'miss, so keeper stopped pinging this session'}`)
  if (state.doneAt !== undefined) lines.push(`muted: by /cache-keeper:done at ${hhmm(state.doneAt)}, until your next message`)
  if (compactedSinceRequest(state)) lines.push(`compacted: ${NOTHING_TO_HOLD.compacted}`)
  return lines
}

/** Settings that leave keeper unable to ping at all, which nothing else reports. */
export function configWarnings(config: Config): string[] {
  const { minAgeSec, maxAgeSec } = config.thresholds
  const out: string[] = []
  if (minAgeSec >= maxAgeSec) out.push(`minAgeSec (${minAgeSec}) is not below maxAgeSec (${maxAgeSec}): no ping is ever due`)
  else if (config.delaySec < minAgeSec || config.delaySec >= maxAgeSec) {
    out.push(`delaySec (${config.delaySec}) is outside minAgeSec..maxAgeSec (${minAgeSec}..${maxAgeSec}): the Stop sleeper never pings (the mod's fork timer still does)`)
  }
  return out
}

/** The whole `/cache-keeper:status` reply. */
export function statusReport(state: SessionState | undefined, config: Config, env: NodeJS.ProcessEnv, now: number): string {
  const cap = effectiveMaxPings(config)
  const rows = settingsOf(config, env, cap)
  const keyWidth = Math.max(...rows.map((r) => r.key.length))
  const valueWidth = Math.max(...rows.map((r) => r.value.length))
  return [
    'cache-keeper status (nothing was sent to the model)',
    '',
    ...sessionLines(state, config, now, cap.value).map((l) => `  ${l}`),
    ...configWarnings(config).map((w) => `  warning: ${w}`),
    '',
    `settings (from env, ${config.home}/config.json, the tuner, or the default):`,
    ...rows.map((r) => `  ${r.key.padEnd(keyWidth)}  ${r.value.padEnd(valueWidth)}  ${r.source}`),
  ].join('\n')
}
