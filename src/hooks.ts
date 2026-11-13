/**
 * The hooks block, generated from one place so the plugin's `hooks/hooks.json`
 * and `cache-keeper install-snippet` cannot drift apart (a test compares them).
 */

import { DEFAULT_DELAY_SEC } from './config.ts'

/**
 * Every hook enters through bin/cache-keeper.sh: it runs cache-keeper.ts under a
 * node that can, and otherwise exits 0 in silence (`check` says why).
 */
export const LAUNCH = 'sh'

/** The plugin form: Claude Code substitutes the variable before the shell sees it. */
export const PLUGIN_SCRIPT = '"${CLAUDE_PLUGIN_ROOT}/bin/cache-keeper.sh"'

/** touch may start a new session from a handoff brief (handoff-run.ts allows the spawn 45 s). */
export const TOUCH_TIMEOUT_SEC = 60

/** Upper bound for the waiter. Documented as unenforced for async hooks; set anyway in case it is. */
export const WAIT_TIMEOUT_SEC = 7200

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * `sleep` holds the idle session (~1 MB) instead of a node process; the hook
 * input stays unread in the stdin pipe and is consumed by `wake` afterwards.
 *
 * Skipped under `CLAUDE_CODE_ENTRYPOINT=sdk-cli` (`claude -p`): there async
 * hooks are not backgrounded, so the sleep would hold a one-shot run open for
 * the whole delay.
 */
export function waitCommand(script: string): string {
  return (
    `[ "$CLAUDE_CODE_ENTRYPOINT" = sdk-cli ] || ` +
    `{ sleep "\${CACHE_KEEPER_DELAY_SEC:-${DEFAULT_DELAY_SEC}}"; ${LAUNCH} ${script} wake; }`
  )
}

interface CommandHook {
  type: 'command'
  command: string
  timeout: number
  asyncRewake?: boolean
}

export interface HooksBlock {
  hooks: Record<'SessionStart' | 'Stop' | 'UserPromptSubmit' | 'SessionEnd', Array<{ hooks: CommandHook[] }>>
}

export function buildHooks(script: string): HooksBlock {
  const run = (sub: string, timeout = 10): CommandHook => ({ type: 'command', command: `${LAUNCH} ${script} ${sub}`, timeout })
  return {
    hooks: {
      // Silent while Node fits; else says why keeper is off (bin/cache-keeper.sh).
      SessionStart: [{ hooks: [run('check')] }],
      Stop: [
        {
          hooks: [
            run('record'),
            { type: 'command', command: waitCommand(script), asyncRewake: true, timeout: WAIT_TIMEOUT_SEC },
          ],
        },
      ],
      UserPromptSubmit: [{ hooks: [run('touch', TOUCH_TIMEOUT_SEC)] }],
      SessionEnd: [{ hooks: [run('end')] }],
    },
  }
}
