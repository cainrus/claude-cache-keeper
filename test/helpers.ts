import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Ctx } from '../src/commands.ts'
import { loadConfig, type Config } from '../src/config.ts'

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
export const SID = '00000000-0000-4000-8000-00000000abcd'
export const MIN = 60_000

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'cache-keeper-test-'))
}

export function configFor(home: string, env: Record<string, string> = {}): Config {
  return loadConfig({ HOME: '/nonexistent', CACHE_KEEPER_HOME: home, ...env })
}

export interface TestCtx extends Ctx {
  errors: string[]
  probes: number
}

export function makeCtx(config: Config, now: number, idle: number | null = 0): TestCtx {
  const ctx: TestCtx = {
    config,
    now,
    errors: [],
    probes: 0,
    idleSeconds: () => {
      ctx.probes++
      return idle
    },
    stderr: (t) => ctx.errors.push(t),
  }
  return ctx
}

export interface UsageSpec {
  at: number
  input?: number
  read?: number
  write?: number
  output?: number
  model?: string
}

export function assistantLine(u: UsageSpec, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    sessionId: SID,
    cwd: '/home/user/project',
    timestamp: new Date(u.at).toISOString(),
    message: {
      model: u.model ?? 'claude-opus-4-5',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: u.input ?? 5,
        cache_read_input_tokens: u.read ?? 0,
        cache_creation_input_tokens: u.write ?? 0,
        output_tokens: u.output ?? 10,
      },
    },
    ...extra,
  })
}

/** Write a transcript whose last main-thread turn has the given usage. */
export function writeTranscript(dir: string, turns: UsageSpec[], name = 'transcript.jsonl'): string {
  const path = join(dir, name)
  writeFileSync(path, `${turns.map((t) => assistantLine(t)).join('\n')}\n`)
  return path
}
