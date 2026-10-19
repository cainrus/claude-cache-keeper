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
export type PsLine = (pid: number) => string | undefined

const realPs: PsLine = pid => {
  try {
    return execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  } catch {
    return undefined
  }
}

/** An interactive session (`claude`) or a background one (`claude bg-spare`). */
const SESSION_COMM = /(^|\/)claude( bg-spare)?$/

/**
 * Above a background session: its pty host, then the daemon that runs every
 * background session of the profile. Neither is the session.
 */
const BEYOND_SESSION_COMM = /(^|\/)claude bg-pty-host$/

/**
 * The session this hook runs in. A background session's process is named
 * `claude bg-spare`; walking past it would reach the daemon, whose name is
 * plain `claude`, and closing that ends every background session.
 */
export function claudeAncestor(startPid = process.ppid, ps: PsLine = realPs): number | undefined {
  let pid = startPid
  for (let i = 0; i < 10 && pid > 1; i++) {
    const line = ps(pid)
    if (line === undefined) return undefined
    const [ppid, ...rest] = line.split(/\s+/)
    const comm = rest.join(' ')
    if (SESSION_COMM.test(comm)) return pid
    if (BEYOND_SESSION_COMM.test(comm)) return undefined
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
      child.unref()
    },
  }
}
