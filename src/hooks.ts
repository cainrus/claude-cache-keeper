/**
 * The hooks block, generated from one place so the plugin's `hooks/hooks.json`
 * and `cache-keeper install-snippet` cannot drift apart (a test compares them).
 */

import { DEFAULT_DELAY_SEC } from './config.ts'

/** Type stripping still warns on some Node 22 releases; on a wake that warning would reach the model. */
export const NODE = 'node --disable-warning=ExperimentalWarning'

/** The plugin form: Claude Code substitutes the variable before the shell sees it. */
export const PLUGIN_SCRIPT = '"${CLAUDE_PLUGIN_ROOT}/bin/cache-keeper.ts"'

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
    `{ sleep "\${CACHE_KEEPER_DELAY_SEC:-${DEFAULT_DELAY_SEC}}"; ${NODE} ${script} wake; }`
  )
}

interface CommandHook {
  type: 'command'
  command: string
  timeout: number
  asyncRewake?: boolean
}

export interface HooksBlock {
  hooks: Record<'Stop' | 'UserPromptSubmit' | 'SessionEnd', Array<{ hooks: CommandHook[] }>>
}

export function buildHooks(script: string): HooksBlock {
  const run = (sub: string): CommandHook => ({ type: 'command', command: `${NODE} ${script} ${sub}`, timeout: 10 })
  return {
    hooks: {
      Stop: [
        {
          hooks: [
            run('record'),
            { type: 'command', command: waitCommand(script), asyncRewake: true, timeout: WAIT_TIMEOUT_SEC },
          ],
        },
      ],
      UserPromptSubmit: [{ hooks: [run('touch')] }],
      SessionEnd: [{ hooks: [run('end')] }],
    },
  }
}
