/**
 * Is a human at this machine? macOS `HIDIdleTime` from IOHIDSystem: nanoseconds
 * since the last keyboard/mouse event. It keeps counting while the lid is shut
 * or the screen is locked, which is exactly the "gone" we want to detect.
 *
 * Every failure is `null` (unknown), never a number: the policy treats unknown
 * differently from both "here" and "gone".
 */

import { execFileSync } from 'node:child_process'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

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

/** The tail of a transcript is enough: every line Claude Code writes carries the session kind. */
const KIND_TAIL_BYTES = 16_384

/**
 * Is this a background session, one that nobody watches at an input box? Claude Code starts
 * background sessions with `CLAUDE_JOB_DIR` and stamps their transcript lines `"sessionKind":"bg"`;
 * hooks inherit the first, the second is the fallback. `CACHE_KEEPER_BACKGROUND=0|1` overrides both.
 */
export function isBackgroundSession(env: NodeJS.ProcessEnv = process.env, transcriptPath?: string): boolean {
  const forced = env.CACHE_KEEPER_BACKGROUND
  if (forced === '0' || forced === '1') return forced === '1'
  if (env.CLAUDE_JOB_DIR) return true
  if (!transcriptPath) return false
  try {
    const fd = openSync(transcriptPath, 'r')
    try {
      const size = fstatSync(fd).size
      const len = Math.min(size, KIND_TAIL_BYTES)
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, size - len)
      return buf.toString('utf8').includes('"sessionKind":"bg"')
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}
