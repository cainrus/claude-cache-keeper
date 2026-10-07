/**
 * The process side of a handoff: the detached apply step and the real
 * `claude` / restart runners. Kept apart from handoff.ts so that one stays
 * testable without spawning anything.
 */

import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from './config.ts'
import type { ApplyDeps, ClaudeRun } from './handoff.ts'

export const VERIFY_TIMEOUT_MS = 180_000
export const RESTART_TIMEOUT_MS = 60_000

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
  out.CACHE_KEEPER_DISABLED = '1'
  return out
}

export function realDeps(config: Config): ApplyDeps {
  const settings = join(config.home, 'handoff-verify-settings.json')
  return {
    config,
    now: () => Date.now(),
    runClaude(args, cwd): ClaudeRun {
      mkdirSync(config.home, { recursive: true })
      writeFileSync(settings, `${JSON.stringify({ disableAllHooks: true })}\n`)
      const r = spawnSync(config.handoff.claudeBin, [...args, '--settings', settings], {
        cwd,
        env: childEnv(process.env),
        encoding: 'utf8',
        timeout: VERIFY_TIMEOUT_MS,
      })
      return { status: r.status, stdout: r.stdout ?? '' }
    },
    runRestart(command, sessionId, transcriptPath) {
      const r = spawnSync('/bin/sh', ['-c', command], {
        env: { ...process.env, CACHE_KEEPER_SESSION_ID: sessionId, CACHE_KEEPER_TRANSCRIPT_PATH: transcriptPath },
        stdio: 'ignore',
        timeout: RESTART_TIMEOUT_MS,
      })
      return r.error === undefined && r.status === 0
    },
  }
}

/** Run `<script> handoff-apply <sid>` detached: it outlives the Stop hook and the restart it causes. */
export function spawnApply(script: string, sessionId: string): void {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', script, 'handoff-apply', sessionId], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
}
