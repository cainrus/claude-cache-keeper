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
 */

import type { Register } from 'claude-code'

/** The spawn behind menu choice 2 may take a while (handoff-run.ts allows it 45 s). */
const GATE_TIMEOUT_MS = 60_000

/** Held in the record and written into the continue file: enough to recognise it. */
const HELD_CHARS = 4000

/** The reason to show when the gate stopped the input, else undefined. */
async function ask($, text: string, turn = false): Promise<string | undefined> {
  const sessionId = await $.session.id()
  const { exitCode, stdout } = await $.process.run(
    ['node', '--disable-warning=ExperimentalWarning', `${$.plugin.root}/bin/cache-keeper.ts`, 'gate'],
    { stdin: JSON.stringify({ session_id: sessionId, prompt: text.slice(0, HELD_CHARS), gate_turn: turn }), timeoutMs: GATE_TIMEOUT_MS },
  )
  if (exitCode !== 0 || stdout.trim() === '') return undefined
  const out = JSON.parse(stdout)
  return out.decision === 'block' && typeof out.reason === 'string' ? out.reason : undefined
}

export const register: Register = on => {
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
    if (e.trigger !== 'manual') return next(e)
    const reason = await ask($, '/compact')
    return reason === undefined ? next(e) : { skip: reason }
  })
}
