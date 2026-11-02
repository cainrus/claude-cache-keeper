/**
 * Pings as `$.model.fork` (src/fork.ts). A fork replays the main thread's last
 * request with one question after it: the API reads the prefix from the
 * cache and renews it, and nothing lands in the transcript. This file only
 * keeps the timer and makes the calls; every decision is the CLI's, the same
 * one the Stop sleeper asks. gate.ts, the plugin's one hooks module, wires it in.
 *
 *   turn.complete    `arm`: the mod takes the stretch, the next ping is due one delay on
 *   session.start    `arm` after a reload, which drops this module's timers
 *   timer            `fork-wake`, then `$.model.fork`, then `forked` to score it.
 *                    A fork with no reply falls back to the wake turn
 *   session.compact  `compact-check` (via gate.ts): after a stretch held by forks
 *                    alone, one wake turn goes first (anthropics/claude-code#105017);
 *                    `compacted` once it ran: the next ping is a wake turn
 *
 * Every step fails safe: a CLI that does not answer leaves the stretch
 * unpinged (cheap), never a second ping. Where the module does not load,
 * nothing arms, and the Stop sleeper pings with a wake turn as before.
 */

const CLI_TIMEOUT_MS = 20_000
/** `$.session.compact` rejects while a turn runs; turn.complete may come just before it is over. */
const COMPACT_RETRY_MS = [1_000, 3_000, 10_000]
/** `$.model.fork` has no timeout of its own (anthropics/claude-code#101446). */
const FORK_TIMEOUT_MS = 120_000
/** A put-off compaction older than this is dropped: its renewing turn never ended. */
const COMPACT_AFTER_TURN_MS = 120_000

type Answer =
  | { action: 'none'; dueInSec?: number }
  | { action: 'fork'; prompt: string }
  | { action: 'turn'; text: string }
  | { action: 'pass' }
  | { action: 'renew'; text: string }

// One copy per load: a reload starts these over, and session.start re-arms.
let timer: { cancel: () => void } | undefined
let forking = false
/** A compaction put off behind a renewing turn: run it when that turn ends. */
let compactAfterTurn: { instructions?: string; at: number } | undefined

async function cli($, cmd: string, payload: Record<string, unknown> = {}): Promise<Answer | undefined> {
  try {
    const sessionId = await $.session.id()
    const { exitCode, stdout } = await $.process.run(
      ['node', '--disable-warning=ExperimentalWarning', `${$.plugin.root}/bin/cache-keeper.ts`, cmd],
      { stdin: JSON.stringify({ session_id: sessionId, ...payload }), timeoutMs: CLI_TIMEOUT_MS },
    )
    const line = exitCode === 0 ? stdout.trim().split('\n').pop() : undefined
    return line ? (JSON.parse(line) as Answer) : undefined
  } catch {
    return undefined
  }
}

function schedule($, sec: number | undefined): void {
  timer?.cancel()
  timer = sec === undefined ? undefined : $.clock.after(sec * 1000, () => void tick($))
}

function submit($, text: string): void {
  // Not awaited: it resolves only once the turn starts, after the calling hook.
  void $.prompt.submit({ text }).catch(() => {})
}

/** Re-arm from a tick, unless a turn ended meanwhile and armed a timer of its own. */
function reschedule($, sec: number | undefined): void {
  if (timer === undefined && sec !== undefined) schedule($, sec)
}

async function fork($, prompt: string) {
  let timeout: { cancel: () => void } | undefined
  try {
    return await Promise.race([
      $.model.fork({ prompt }),
      new Promise(resolve => {
        timeout = $.clock.after(FORK_TIMEOUT_MS, () => resolve({ isAnswered: false, reason: 'timeout' }))
      }),
    ])
  } catch {
    return { isAnswered: false, reason: 'threw' }
  } finally {
    timeout?.cancel()
  }
}

async function tick($): Promise<void> {
  timer = undefined
  const a = await cli($, 'fork-wake')
  if (a?.action === 'none') return reschedule($, a.dueInSec)
  if (a?.action === 'turn') return submit($, a.text)
  if (a?.action !== 'fork') return
  forking = true
  let r
  try {
    r = await fork($, a.prompt)
  } finally {
    forking = false
  }
  const result = r.isAnswered ? { isAnswered: true, usage: r.usage } : { isAnswered: false, reason: r.reason }
  const s = await cli($, 'forked', { fork: result })
  if (s?.action === 'turn') return submit($, s.text)
  if (s?.action === 'none') reschedule($, s.dueInSec)
}

/**
 * The put-off compaction. The engine does not raise a plugin's own call in its
 * own hooks (measured: "skipped: re-entry"), so gate.ts never sees this one
 * and `compacted` is reported from here.
 */
async function compactLater($, instructions: string | undefined): Promise<void> {
  for (const ms of COMPACT_RETRY_MS) {
    await $.clock.sleep(ms)
    let result
    try {
      result = await $.session.compact(instructions === undefined ? {} : { instructions })
    } catch {
      // A turn is still running: try again a little later.
      continue
    }
    if (result?.skip === undefined) await cli($, 'compacted')
    return
  }
}

async function afterTurn($, claim: boolean): Promise<void> {
  if (claim) {
    const a = await cli($, 'arm')
    if (a?.action === 'none') schedule($, a.dueInSec)
  }
  if (compactAfterTurn) {
    const { instructions, at } = compactAfterTurn
    compactAfterTurn = undefined
    if ((await $.clock.now()) - at < COMPACT_AFTER_TURN_MS) await compactLater($, instructions)
  }
}

/** Called by gate.ts's `session.start` hook, after the engine started: a reload drops the timer. */
export function keepaliveStarted($): void {
  // Detached, so the session's start is not held by a process spawn.
  $.clock.after(0, async () => {
    const a = await cli($, 'arm', { reload: true })
    if (a?.action === 'none') schedule($, a.dueInSec)
  })
}

/** Called by gate.ts's `turn.complete` hook, after the engine finished the turn. */
export function keepaliveTurnDone($, e): void {
  // Detached, so the turn's end is not held by a process spawn.
  // A turn ending under a fork in flight does not claim (the fork's own result re-arms).
  if (e.agentId === undefined) $.clock.after(0, () => void afterTurn($, !forking))
}

/**
 * Called by gate.ts's `session.compact` hook once the engine compacted: until
 * the next turn sends it, the new prefix is in no cache, so the next ping goes
 * as a wake turn (src/fork.ts). A precompute or a skipped compaction changed nothing.
 */
export function keepaliveCompacted($, e, result): void {
  if (e.agentId !== undefined || e.trigger === 'precompute' || result?.skip !== undefined) return
  $.clock.after(0, () => void cli($, 'compacted'))
}

/** Called by gate.ts's `session.compact` hook: `{ skip }` while a renewing turn goes first. */
export async function beforeCompact($, e): Promise<{ skip: string } | undefined> {
  if (e.agentId !== undefined || (e.trigger !== 'manual' && e.trigger !== 'plugin')) return undefined
  const a = await cli($, 'compact-check', { trigger: e.trigger })
  if (a?.action !== 'renew') return undefined
  const instructions = e.instructions
  compactAfterTurn = { instructions, at: await $.clock.now() }
  // A renewing turn that could not start: compact now, cold, rather than never.
  void $.prompt.submit({ text: a.text }).catch(() => {
    compactAfterTurn = undefined
    void compactLater($, instructions)
  })
  return {
    skip:
      'cache-keeper: one keep-alive turn first, so the compaction reads the warm cache ' +
      '(anthropics/claude-code#105017); it compacts right after.',
  }
}
