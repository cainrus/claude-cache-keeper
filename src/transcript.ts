/**
 * The last main-thread assistant `usage` of a Claude Code JSONL transcript.
 *
 * Transcripts grow to tens of megabytes, so the file is read from the end in
 * growing chunks until a qualifying line turns up. Sidechain (subagent) lines
 * and synthetic entries are skipped: their usage is not the main conversation's
 * cache.
 */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

export interface TurnUsage {
  inputTokens: number
  cacheRead: number
  cacheWrite: number
  outputTokens: number
  /** input + cache read + cache write: the size of the cached prefix. */
  ctxTokens: number
  model?: string
  /** Epoch ms of the transcript entry, when it carries a parseable timestamp. */
  timestamp?: number
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

/** Parse one transcript line; undefined unless it is a main-thread assistant turn with usage. */
export function usageFromLine(line: string): TurnUsage | undefined {
  if (!line.includes('"usage"')) return undefined
  let rec: any
  try {
    rec = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!rec || rec.type !== 'assistant' || rec.isSidechain === true) return undefined
  const msg = rec.message
  const u = msg?.usage
  if (!u || typeof u !== 'object') return undefined
  if (msg.model === '<synthetic>') return undefined

  const inputTokens = n(u.input_tokens)
  const cacheRead = n(u.cache_read_input_tokens)
  const cacheWrite = n(u.cache_creation_input_tokens)
  const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN
  return {
    inputTokens,
    cacheRead,
    cacheWrite,
    outputTokens: n(u.output_tokens),
    ctxTokens: inputTokens + cacheRead + cacheWrite,
    ...(typeof msg.model === 'string' ? { model: msg.model } : {}),
    ...(Number.isFinite(ts) ? { timestamp: ts } : {}),
  }
}

export function lastMainUsage(transcriptPath: string, initialChunk = 256 * 1024): TurnUsage | undefined {
  let fd: number
  try {
    fd = openSync(transcriptPath, 'r')
  } catch {
    return undefined
  }
  try {
    const size = fstatSync(fd).size
    let chunk = Math.max(1024, initialChunk)
    for (;;) {
      const start = Math.max(0, size - chunk)
      const buf = Buffer.alloc(size - start)
      readSync(fd, buf, 0, buf.length, start)
      const lines = buf.toString('utf8').split('\n')
      // The first line of a partial window is probably cut; the rest are whole.
      const from = start === 0 ? 0 : 1
      for (let i = lines.length - 1; i >= from; i--) {
        const u = usageFromLine(lines[i])
        if (u) return u
      }
      if (start === 0) return undefined
      chunk *= 4
    }
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
}
