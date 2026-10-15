#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * cache-keeper — keep an idle Claude Code session's prompt cache warm.
 * Entry point for every hook and for the human-facing subcommands.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { end, record, touch, wake, type Ctx, type HookInput } from '../src/commands.ts'
import { loadConfig } from '../src/config.ts'
import { realIO } from '../src/handoff-run.ts'
import { buildHooks, shellQuote, waitCommand } from '../src/hooks.ts'
import { readLedger } from '../src/ledger.ts'
import { readIdleSeconds } from '../src/presence.ts'
import { formatReport, summarize } from '../src/report.ts'
import { runSkipIf } from '../src/veto.ts'

const VERSION = '0.3.0'

const USAGE = `cache-keeper ${VERSION} — keep an idle Claude Code session's prompt cache warm

Hook subcommands (read the hook input JSON on stdin):
  record            Stop, sync: note the finished turn, score a wake turn
  wake              Stop, after the sleep (asyncRewake): exit 2 = ping, 0 = no ping
  touch             UserPromptSubmit: a real prompt closes the idle stretch;
                    into a cold cache with a handoff brief, it asks first
  end               SessionEnd: forget the session

Other:
  report [--json]   summarise the decision ledger
  install-snippet   print a settings.json "hooks" block for use without the plugin
  wait-cmd          print the shell command of the waiting Stop hook
  --help, --version

State lives in $CACHE_KEEPER_HOME (default ~/.claude-cache-keeper).
Design: https://github.com/cainrus/claude-cache-keeper/blob/main/docs/DESIGN.md`

function readStdin(): string {
  if (process.stdin.isTTY) return ''
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function parseInput(raw: string): HookInput {
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as HookInput) : {}
  } catch {
    return {}
  }
}

const HOOKS: Record<string, (input: HookInput, ctx: Ctx) => number> = { record, wake, touch, end }

function main(argv: string[]): number {
  const [cmd, ...rest] = argv
  if (cmd === undefined || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (cmd === '--version' || cmd === '-v') {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  const hook = HOOKS[cmd]
  if (hook) {
    // A hook must never break the session it runs in: any failure is exit 0.
    try {
      const config = loadConfig()
      const { skipIf } = config
      const ctx: Ctx = {
        config,
        now: Date.now(),
        idleSeconds: () => readIdleSeconds(),
        stderr: (text) => process.stderr.write(text),
        stdout: (text) => process.stdout.write(text),
        handoffIO: realIO(config),
        ...(skipIf ? { skipIf: (facts) => runSkipIf(skipIf, facts) } : {}),
      }
      return hook(parseInput(readStdin()), ctx)
    } catch (err) {
      process.stderr.write(`cache-keeper ${cmd}: ${(err as Error)?.message ?? err}\n`)
      return 0
    }
  }

  const script = shellQuote(fileURLToPath(import.meta.url))
  switch (cmd) {
    case 'report': {
      const config = loadConfig()
      const summary = summarize(readLedger(config.home), config)
      process.stdout.write(rest.includes('--json') ? `${JSON.stringify(summary, null, 2)}\n` : formatReport(summary))
      return 0
    }
    case 'install-snippet':
      process.stderr.write('# Merge this "hooks" object into ~/.claude/settings.json (or a project settings file):\n')
      process.stdout.write(`${JSON.stringify(buildHooks(script), null, 2)}\n`)
      return 0
    case 'wait-cmd':
      process.stdout.write(`${waitCommand(script)}\n`)
      return 0
    default:
      process.stderr.write(`cache-keeper: unknown command "${cmd}"\n\n${USAGE}\n`)
      return 64
  }
}

process.exitCode = main(process.argv.slice(2))
