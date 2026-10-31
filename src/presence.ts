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

/** One probe never holds the wake for long: Linux tries up to four in a row. */
const PROBE_TIMEOUT_MS = 2000

const defaultExec: Exec = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] })

export interface ProbeOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  exec?: Exec
  /** Epoch ms; logind reports idle as a point in time. */
  now?: number
  uid?: number
}

export function readIdleSeconds(opts: ProbeOptions = {}): number | null {
  const env = opts.env ?? process.env
  const override = env.CACHE_KEEPER_IDLE_SEC
  if (override !== undefined) return parseIdleOverride(override)
  const exec = opts.exec ?? defaultExec
  const platform = opts.platform ?? process.platform
  if (platform === 'linux') return linuxIdleSeconds(exec, opts.now ?? Date.now(), opts.uid ?? process.getuid?.() ?? 0)
  if (platform !== 'darwin') return null
  try {
    return parseIdleSeconds(exec('ioreg', ['-c', 'IOHIDSystem', '-d', '4']))
  } catch {
    return null
  }
}

// --- Linux -----------------------------------------------------------------
//
// No single source covers every desktop, so the probes are tried in order and
// the first answer wins. The precise ones need the desktop's session bus or X
// display, which a hook inherits from an interactive session but usually not
// from a daemon-spawned one; logind needs neither, which is why it is last but
// still there. Every probe that is missing, fails or prints something else
// falls through, and nothing answering is null, as on any other platform.

/** `gdbus call` prints a tuple such as `(uint64 12345,)`; the number, or null. */
export function parseGdbusUint(out: string): number | null {
  const m = out.match(/^\(\s*(?:uint32|uint64)\s+(\d+)\s*,?\s*\)\s*$/m)
  return m ? Number(m[1]) : null
}

/** A bare integer on its own (xprintidle prints idle milliseconds). */
export function parseBareInt(out: string): number | null {
  const s = out.trim()
  return /^\d+$/.test(s) ? Number(s) : null
}

/**
 * `loginctl show-user` lines -> idle seconds. Trusted only while the user has
 * a graphical session (`Display=`): without a desktop to set it, IdleHint can
 * stay "no" forever, which would read as "at the keyboard" and lift the away
 * budget. `IdleHint=no` is 0: the desktop's own idle delay (5 min on GNOME by
 * default) has not passed, so the human counts as present.
 */
export function parseLoginctlUser(out: string, now: number): number | null {
  const props = new Map<string, string>()
  for (const line of out.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) props.set(line.slice(0, i).trim(), line.slice(i + 1).trim())
  }
  if (!props.get('Display')) return null
  const hint = props.get('IdleHint')
  if (hint === 'no') return 0
  if (hint !== 'yes') return null
  const sinceUs = Number(props.get('IdleSinceHint'))
  if (!Number.isFinite(sinceUs) || sinceUs <= 0) return null
  return Math.max(0, Math.floor((now - sinceUs / 1000) / 1000))
}

const gdbus = (dest: string, path: string, method: string) => [
  'call', '--session', '--dest', dest, '--object-path', path, '--method', method,
]

interface LinuxProbe {
  name: string
  cmd: string
  args: (uid: number) => string[]
  /** Command output -> idle seconds, or null to try the next probe. */
  parse: (out: string, now: number) => number | null
}

const msToSec = (ms: number | null) => (ms === null ? null : Math.floor(ms / 1000))

export const LINUX_PROBES: readonly LinuxProbe[] = [
  {
    name: 'mutter', // GNOME, X11 and Wayland: milliseconds
    cmd: 'gdbus',
    args: () => gdbus('org.gnome.Mutter.IdleMonitor', '/org/gnome/Mutter/IdleMonitor/Core', 'org.gnome.Mutter.IdleMonitor.GetIdletime'),
    parse: (out) => msToSec(parseGdbusUint(out)),
  },
  {
    name: 'screensaver', // KDE and others implementing the freedesktop interface: seconds
    cmd: 'gdbus',
    args: () => gdbus('org.freedesktop.ScreenSaver', '/org/freedesktop/ScreenSaver', 'org.freedesktop.ScreenSaver.GetSessionIdleTime'),
    parse: (out) => parseGdbusUint(out),
  },
  {
    name: 'xprintidle', // any X11 session: milliseconds
    cmd: 'xprintidle',
    args: () => [],
    parse: (out) => msToSec(parseBareInt(out)),
  },
  {
    name: 'logind', // systemd, no bus or display needed; as coarse as the desktop's idle delay
    cmd: 'loginctl',
    args: (uid) => ['show-user', String(uid), '-p', 'Display', '-p', 'IdleHint', '-p', 'IdleSinceHint'],
    parse: parseLoginctlUser,
  },
]

export function linuxIdleSeconds(exec: Exec, now: number, uid: number): number | null {
  for (const p of LINUX_PROBES) {
    try {
      const v = p.parse(exec(p.cmd, p.args(uid)), now)
      if (v !== null && Number.isFinite(v) && v >= 0) return v
    } catch {
      // missing, failing or timed out: the next one
    }
  }
  return null
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
