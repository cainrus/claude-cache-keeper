/**
 * `skipIf`: a user command asked before a ping or a due handoff goes out; it can
 * veto either, or turn the ping into a handoff.
 *
 * The policy only knows what the keeper measures itself. Whether a session is
 * worth holding at all — its task is finished, it was handed off, it belongs
 * to a batch job — is known only to the tooling around it, so the keeper asks
 * that tooling instead of learning its formats.
 *
 * Exit 0 = skip this ping. Exit 3 = do not ping, hand the session off instead:
 * someone else holds it (an orchestrator that started it), and that holder
 * would rather continue in a new session from a brief than keep this one warm.
 * Anything else — another exit, not found, timeout — lets the ping go out: a
 * broken probe must degrade to the keeper's own behaviour, not to a session
 * that silently stops being kept.
 */

import { spawnSync } from 'node:child_process'

export interface SessionFacts {
  sessionId: string
  transcriptPath?: string
  /** Epoch ms of the last real (non-wake) prompt. */
  lastPromptAt?: number
}

/** What the `skipIf` command answered. */
export type Verdict = 'ping' | 'skip' | 'handoff'

export const SKIP_IF_TIMEOUT_MS = 5000
export const HANDOFF_EXIT = 3

export function runSkipIf(command: string, facts: SessionFacts, timeoutMs = SKIP_IF_TIMEOUT_MS): Verdict {
  const r = spawnSync('/bin/sh', ['-c', command], {
    env: {
      ...process.env,
      CACHE_KEEPER_SESSION_ID: facts.sessionId,
      CACHE_KEEPER_TRANSCRIPT_PATH: facts.transcriptPath ?? '',
      CACHE_KEEPER_LAST_PROMPT_AT: facts.lastPromptAt !== undefined ? new Date(facts.lastPromptAt).toISOString() : '',
    },
    stdio: 'ignore',
    timeout: timeoutMs,
  })
  if (r.error !== undefined) return 'ping'
  if (r.status === 0) return 'skip'
  if (r.status === HANDOFF_EXIT) return 'handoff'
  return 'ping'
}
