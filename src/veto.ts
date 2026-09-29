/**
 * `skipIf`: a user command that can veto a ping the policy already approved.
 *
 * The policy only knows what the keeper measures itself. Whether a session is
 * worth holding at all — its task is finished, it was handed off, it belongs
 * to a batch job — is known only to the tooling around it, so the keeper asks
 * that tooling instead of learning its formats.
 *
 * Exit 0 = skip this ping. Anything else — non-zero, not found, timeout — lets
 * the ping go out: a broken probe must degrade to the keeper's own behaviour,
 * not to a session that silently stops being kept.
 */

import { spawnSync } from 'node:child_process'

export interface SessionFacts {
  sessionId: string
  transcriptPath?: string
  /** Epoch ms of the last real (non-wake) prompt. */
  lastPromptAt?: number
}

export const SKIP_IF_TIMEOUT_MS = 5000

export function runSkipIf(command: string, facts: SessionFacts, timeoutMs = SKIP_IF_TIMEOUT_MS): boolean {
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
  return r.error === undefined && r.status === 0
}
