/**
 * Effective configuration: defaults <- `$CACHE_KEEPER_HOME/config.json` <- env.
 *
 * Invalid values are ignored rather than fatal: a hook must never break the
 * session it runs in because of a typo in a settings file.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { THRESHOLDS, type Thresholds } from './policy.ts'

/** USD per million tokens of base input; see `report.ts` for the multipliers. */
export type PriceTable = Record<string, number>

export const DEFAULT_PRICES: PriceTable = {
  opus: 5,
  sonnet: 3,
  haiku: 1,
  default: 5,
}

export interface Config {
  home: string
  enabled: boolean
  thresholds: Thresholds
  /** A wake turn is a cache hit when read / (read + write) >= this. */
  hitRatio: number
  /** Cache TTL the savings estimate assumes (1h on a subscription). */
  cacheTtlSec: number
  /** Delay of the waiter; only informative here — the shell reads the env var itself. */
  delaySec: number
  prices: PriceTable
}

export const DEFAULT_DELAY_SEC = 3000

/** Env var -> threshold key. */
export const THRESHOLD_ENV: Readonly<Record<keyof Thresholds, string>> = Object.freeze({
  awaySec: 'CACHE_KEEPER_AWAY_SEC',
  presenceSec: 'CACHE_KEEPER_PRESENCE_SEC',
  maxAwayPings: 'CACHE_KEEPER_MAX_AWAY_PINGS',
  minCtxTokens: 'CACHE_KEEPER_MIN_CTX_TOKENS',
  minAgeSec: 'CACHE_KEEPER_MIN_AGE_SEC',
  maxAgeSec: 'CACHE_KEEPER_MAX_AGE_SEC',
  maxPings: 'CACHE_KEEPER_MAX_PINGS',
})

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const h = env.CACHE_KEEPER_HOME
  return h && h.trim() !== '' ? h : join(env.HOME ?? homedir(), '.claude-cache-keeper')
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : undefined
  if (typeof v === 'string' && v.trim() !== '') return num(Number(v))
  return undefined
}

function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(s)) return true
    if (['0', 'false', 'no', 'off'].includes(s)) return false
  }
  return undefined
}

function readConfigFile(home: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = resolveHome(env)
  const file = readConfigFile(home)

  const thresholds: Thresholds = { ...THRESHOLDS }
  for (const key of Object.keys(THRESHOLDS) as Array<keyof Thresholds>) {
    const v = num(env[THRESHOLD_ENV[key]]) ?? num(file[key])
    if (v !== undefined) thresholds[key] = v
  }

  const hitRatio = num(env.CACHE_KEEPER_HIT_RATIO) ?? num(file.hitRatio)
  const disabled = bool(env.CACHE_KEEPER_DISABLED)
  const prices: PriceTable = { ...DEFAULT_PRICES }
  if (file.prices && typeof file.prices === 'object') {
    for (const [k, v] of Object.entries(file.prices as Record<string, unknown>)) {
      const p = num(v)
      if (p !== undefined) prices[k] = p
    }
  }

  return {
    home,
    enabled: disabled !== undefined ? !disabled : (bool(file.enabled) ?? true),
    thresholds,
    hitRatio: hitRatio !== undefined && hitRatio <= 1 ? hitRatio : 0.9,
    cacheTtlSec: num(file.cacheTtlSec) ?? 3600,
    delaySec: num(env.CACHE_KEEPER_DELAY_SEC) ?? DEFAULT_DELAY_SEC,
    prices,
  }
}
