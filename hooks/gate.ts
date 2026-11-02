/**
 * The mod half of the plugin. `UserPromptSubmit` fires for a typed prompt and for
 * skills (`/simplify`), but never for a `!` command or a built-in slash command
 * (measured on Claude Code 2.1.301), so those hit a cold cache with no menu.
 * These hooks ask `cache-keeper gate` at the points where such input does reach
 * the model:
 *
 *   turn.step         the first model request of a turn: `!` commands, whatever
 *                     else started a turn without a prompt hook. A refusal is
 *                     answered here, so no request is sent.
 *   session.compact   `/compact`, which sends the whole context cold.
 *
 * Every hook fails open: a broken gate lets the input through.
 *
 * It is also the plugin's one hooks module, so `session.start` and
 * `turn.complete` here call the fork pings (keepalive.ts) and the status line
 * (status.ts), and `session.compact` asks keepalive.ts after the gate.
 */

import type { Register } from 'claude-code'
import { beforeCompact, keepaliveCompacted, keepaliveStarted, keepaliveTurnDone } from './keepalive.ts'
import { statusStarted, statusTurnDone } from './status.ts'

/** The spawn behind menu choice 2 may take a while (handoff-run.ts allows it 45 s). */
const GATE_TIMEOUT_MS = 60_000

/** Held in the record and written into the continue file: enough to recognise it. */
const HELD_CHARS = 4000

/** The reason to show when the gate stopped the input, else undefined. */
async function ask($, text: string, turn = false): Promise<string | undefined> {
  try {
    const sessionId = await $.session.id()
    const { exitCode, stdout } = await $.process.run(
      ['node', '--disable-warning=ExperimentalWarning', `${$.plugin.root}/bin/cache-keeper.ts`, 'gate'],
      { stdin: JSON.stringify({ session_id: sessionId, prompt: text.slice(0, HELD_CHARS), gate_turn: turn }), timeoutMs: GATE_TIMEOUT_MS },
    )
    if (exitCode !== 0 || stdout.trim() === '') return undefined
    const out = JSON.parse(stdout)
    return out.decision === 'block' && typeof out.reason === 'string' ? out.reason : undefined
  } catch {
    // A timeout, a spawn failure or output that is not JSON: let the input through.
    return undefined
  }
}

export const register: Register = on => {
  // A plugin loads one hooks module with one hook per event, so the other
  // halves are called from here: the fork pings (keepalive.ts) and the pinned
  // "cache ↻³ 14:05" line (status.ts).
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    statusStarted($)
    keepaliveStarted($)
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    keepaliveTurnDone($, e)
    statusTurnDone($)
    return done
  })

  // The text a turn began with: turn.step does not carry it.
  const began = new Map<string, string>()

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) began.set(e.turnId, e.text)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined && e.index === 0) {
      const reason = await ask($, began.get(e.turnId) ?? '', true)
      began.delete(e.turnId)
      if (reason !== undefined) {
        yield { kind: 'text', index: 0, text: reason }
        yield { kind: 'stop', stopReason: 'end_turn', usage: null }
        return { turnId: e.turnId, index: e.index, answer: reason, toolUses: [], stopReason: 'end_turn', usage: null }
      }
    }
    return yield* next(e)
  })

  on('session.compact', async ($, e, next) => {
    if (e.trigger === 'manual' && e.agentId === undefined) {
      const reason = await ask($, '/compact')
      if (reason !== undefined) return { skip: reason }
    }
    const renewFirst = await beforeCompact($, e)
    if (renewFirst !== undefined) return renewFirst
    const result = await next(e)
    keepaliveCompacted($, e, result)
    return result
  })
}
