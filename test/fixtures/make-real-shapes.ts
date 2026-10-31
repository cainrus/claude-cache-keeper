/**
 * Writes `real-shapes.jsonl`: a transcript with the line shapes Claude Code
 * 2.1.31x actually writes (surveyed over 150 real transcripts on 2026-10-31),
 * with invented content. Regenerate with
 *
 *   node --experimental-strip-types test/fixtures/make-real-shapes.ts
 *
 * What it covers, tail first (the parser reads from the end):
 * - root values that are not objects, a blank line, a torn last line;
 * - `system` lines a Stop leaves after the answer (turn_duration, stop_hook_summary, away_summary);
 * - an API error turn: `isApiErrorMessage`, model `<synthetic>`, all-zero usage, once with a real model name too;
 * - `attachment` lines;
 * - the full usage object: `cache_creation` split by TTL, server_tool_use, service_tier, iterations;
 * - a manual compaction: `compact_boundary` with `compactMetadata`, then the summary as a user line.
 */

import { writeFileSync } from 'node:fs'

const SID = '00000000-0000-4000-8000-000000000003'
let uuid = 0
const id = () => `00000000-0000-4000-9000-${String(++uuid).padStart(12, '0')}`
const at = (min: number, sec = 0) => new Date(Date.UTC(2026, 0, 1, 10, min, sec)).toISOString()

const common = (min: number, sec = 0) => ({
  parentUuid: uuid === 0 ? null : `00000000-0000-4000-9000-${String(uuid).padStart(12, '0')}`,
  isSidechain: false,
  uuid: id(),
  timestamp: at(min, sec),
  sessionKind: 'interactive',
  userType: 'external',
  entrypoint: 'cli',
  cwd: '/home/user/project',
  sessionId: SID,
  version: '2.1.316',
  gitBranch: 'main',
})

const usage = (input: number, read: number, write: number, output: number) => ({
  output_tokens_details: { thinking_tokens: 0 },
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: write,
  cache_read_input_tokens: read,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: 'standard',
  cache_creation: { ephemeral_1h_input_tokens: write, ephemeral_5m_input_tokens: 0 },
  inference_geo: '',
  iterations: [],
  speed: 'standard',
  fallback_credit: null,
})

const assistant = (min: number, sec: number, u: ReturnType<typeof usage>, model = 'claude-opus-5-5') => ({
  ...common(min, sec),
  type: 'assistant',
  requestId: `req_${uuid}`,
  message: { model, id: `msg_${uuid}`, type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn', usage: u },
})

const user = (min: number, text: string, extra: Record<string, unknown> = {}) => ({
  ...common(min),
  type: 'user',
  message: { role: 'user', content: text },
  ...extra,
})

const system = (min: number, subtype: string, extra: Record<string, unknown> = {}) => ({
  ...common(min),
  type: 'system',
  subtype,
  level: 'info',
  ...extra,
})

const apiError = (min: number, model = '<synthetic>') => ({
  ...common(min),
  type: 'assistant',
  error: 'overloaded_error',
  isApiErrorMessage: true,
  apiErrorStatus: 529,
  message: { model, role: 'assistant', content: [{ type: 'text', text: 'API Error: overloaded' }], stop_reason: 'stop_sequence', usage: usage(0, 0, 0, 0) },
})

const lines: unknown[] = [
  // Before the compaction: a big context.
  user(0, 'refactor the parser'),
  assistant(0, 40, usage(4, 150_000, 10_000, 900)),
  system(1, 'turn_duration', { durationMs: 41_000 }),
  // /compact (manual): boundary, then the summary the next request starts from.
  system(2, 'compact_boundary', { compactMetadata: { trigger: 'manual', preTokens: 160_004, postTokens: 9842 } }),
  user(2, 'This session is being continued from a previous conversation...', { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
  // The first turn after it: the context is small now. This is the usage the parser must return.
  user(3, 'continue'),
  { ...common(3), type: 'attachment', attachment: { type: 'todo', content: [] } },
  assistant(3, 20, usage(6, 18_000, 9_500, 400)),
  system(3, 'stop_hook_summary', { hookCount: 3, hookInfos: [], hookErrors: [], preventedContinuation: false }),
  system(4, 'turn_duration', { durationMs: 20_000 }),
  // A later prompt that failed at the API: not a cache touch.
  user(5, 'and the tests'),
  apiError(5),
  apiError(6, 'claude-opus-5-5'),
  system(7, 'away_summary', { content: 'while you were away' }),
]

const text = [
  ...lines.map((l) => JSON.stringify(l)),
  '',
  '[]',
  'false',
  '{}',
  'null',
  '{"type":"assistant","message":{"usage":{"input_tokens":1', // torn: Claude Code was killed mid-write
].join('\n')

writeFileSync(new URL('./real-shapes.jsonl', import.meta.url), `${text}\n`)
