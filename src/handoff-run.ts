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

/** The nearest ancestor named claude: the session this hook runs in. */
export function claudeAncestor(startPid = process.ppid): number | undefined {
  let pid = startPid
  for (let i = 0; i < 10 && pid > 1; i++) {
    let line: string
    try {
      line = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    } catch {
      return undefined
    }
    const [ppid, ...comm] = line.split(/\s+/)
    if (/(^|\/)claude$/.test(comm.join(' '))) return pid
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
