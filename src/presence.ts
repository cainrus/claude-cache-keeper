/**
 * Is a human at this machine? macOS `HIDIdleTime` from IOHIDSystem: nanoseconds
 * since the last keyboard/mouse event. It keeps counting while the lid is shut
 * or the screen is locked, which is exactly the "gone" we want to detect.
 *
 * Every failure is `null` (unknown), never a number: the policy treats unknown
 * differently from both "here" and "gone".
 */

import { execFileSync } from 'node:child_process'

/** `"HIDIdleTime" = 123456789000` -> whole seconds; null if absent or unparseable. */
export function parseIdleSeconds(ioregOutput: string): number | null {
  const m = ioregOutput.match(/"HIDIdleTime"\s*=\s*(\d+)/)
  if (!m) return null
  const ns = Number(m[1])
  if (!Number.isFinite(ns)) return null
  return Math.floor(ns / 1_000_000_000)
}

/**
 * `CACHE_KEEPER_IDLE_SEC` overrides the probe (tests, non-macOS setups with
 * their own idle source). A number is the idle time; `unknown` or any
 * non-numeric value means null.
 */
export function parseIdleOverride(raw: string): number | null {
  const n = Number(raw)
  return raw.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null
}

export type Exec = (cmd: string, args: string[]) => string

const defaultExec: Exec = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })

export interface ProbeOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  exec?: Exec
}

export function readIdleSeconds(opts: ProbeOptions = {}): number | null {
  const env = opts.env ?? process.env
  const override = env.CACHE_KEEPER_IDLE_SEC
  if (override !== undefined) return parseIdleOverride(override)
  if ((opts.platform ?? process.platform) !== 'darwin') return null
  try {
    return parseIdleSeconds((opts.exec ?? defaultExec)('ioreg', ['-c', 'IOHIDSystem', '-d', '4']))
  } catch {
    return null
  }
}
