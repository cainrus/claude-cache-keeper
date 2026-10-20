/**
 * The process side of a handoff: run the spawn command, and close the old
 * session once the hook that decided it has returned. Kept apart from
 * handoff.ts so that one stays testable without spawning anything.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import type { Config } from './config.ts'
import type { HandoffIO } from './handoff.ts'

/** The touch hook's own timeout is 60 s; leave room for the rest of it. */
export const SPAWN_TIMEOUT_MS = 45_000

/** Long enough for the hook to answer before its session goes away. */
export const CLOSE_DELAY_SEC = 2

/**
 * The env a nested `claude` needs: the session's own credentials and config
 * dir, but none of the variables that mark it a child of this session — with
 * those it writes no transcript and `--resume` finds nothing.
 */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || k === 'CLAUDECODE') continue
    if (k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDE_CODE_OAUTH_TOKEN') continue
    out[k] = v
  }
  return out
}

/** `ps -o ppid=,comm=` for one pid, or undefined when it is gone. */
export type ReadPsLine = (pid: number) => string | undefined

const readPsLine: ReadPsLine = pid => {
  try {
    return execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }
}

/** A hook sits two or three processes below its session; the cap only stops a runaway walk. */
const MAX_ANCESTORS = 10

/**
 * Titles that are a session, as `ps -o comm=` prints them (macOS, Claude Code
 * 2.1.303-2.1.304): interactive `claude` or `…/claude/versions/2.1.304`,
 * background `claude bg-spare`. The daemon that runs every background session
 * is `…/.local/bin/claude`, and the pty host between it and a background
 * session is `claude bg-pty-host`: neither may match.
 */
const SESSION_COMM = [/^claude$/, /^claude bg-spare$/, /\/claude\/versions\/\d+\.\d+\.\d+$/]

/**
 * The session this hook runs in. The nearest ancestor whose title mentions
 * `claude` decides: it is the session when its title is a known session title,
 * and otherwise there is none. Walking on past an unknown title could reach the
 * daemon, and closing that ends every background session.
 */
export function claudeAncestor(startPid = process.ppid, ps: ReadPsLine = readPsLine): number | undefined {
  let pid = startPid
  for (let i = 0; i < MAX_ANCESTORS && pid > 1; i++) {
    const m = ps(pid)?.match(/^(\d+)\s+(.*)$/)
    if (!m) return undefined
    const [, ppid, comm] = m
    if (comm.includes('claude')) return SESSION_COMM.some(re => re.test(comm)) ? pid : undefined
    pid = Number(ppid)
  }
  return undefined
}

export function realIO(config: Config): HandoffIO {
  return {
    spawn(command, extra) {
      const r = spawnSync('/bin/sh', ['-c', command], {
        env: { ...childEnv(process.env), ...extra },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: SPAWN_TIMEOUT_MS,
      })
      const output = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`
      return { ok: r.error === undefined && r.status === 0, output }
    },
    closeLater(sessionId) {
      const pid = claudeAncestor()
      const command = config.handoff.closeCommand ?? (pid ? `kill -TERM ${pid}` : undefined)
      if (!command) return
      // Detached: killing the session kills this hook too, so the close must outlive it.
      const child = spawn('/bin/sh', ['-c', `sleep ${CLOSE_DELAY_SEC}; ${command}`], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, CACHE_KEEPER_SESSION_ID: sessionId, CACHE_KEEPER_CLAUDE_PID: pid ? String(pid) : '' },
      })
      // The handoff already happened; a close that cannot start leaves the old session open.
      child.on('error', () => {})
      child.unref()
    },
  }
}
