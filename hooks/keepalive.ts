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
 *                    A fork with no reply is sent again (`fork-retry`) while it can still
 *                    land warm, then falls back to the wake turn, or to nothing past maxAgeSec
 *   session.compact  `compact-check` (via gate.ts): after a stretch held by forks
 *                    alone, one wake turn goes first (anthropics/claude-code#105017);
 *                    `compacted` once it ran: the next ping is a wake turn
 *   turn.step        `/cache-keeper:ping` (via gate.ts, `manualPing`): `ping-now`, then
 *                    `$.model.fork`, then `forked`; the fork's line answers the turn
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
  | { action: 'none'; dueInSec?: number; text?: string }
  | { action: 'fork'; prompt: string }
  | { action: 'turn'; text: string }
  | { action: 'pass' }
  | { action: 'renew'; text: string }
  | { action: 'retry'; afterSec: number }

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

/** `$.model.fork`'s result in the shape the CLI's `forked` reads. */
function forkResult(r) {
  return r.isAnswered ? { isAnswered: true, usage: r.usage } : { isAnswered: false, reason: r.reason }
}

async function tick($): Promise<void> {
  timer = undefined
  const a = await cli($, 'fork-wake')
  if (a?.action === 'none') return reschedule($, a.dueInSec)
  if (a?.action === 'turn') return submit($, a.text)
  if (a?.action === 'fork') await sendFork($, a.prompt)
}

/** `forked` answered `retry`: ask `fork-retry` once the pause is over. */
async function retryTick($): Promise<void> {
  timer = undefined
  const a = await cli($, 'fork-retry')
  if (a?.action === 'fork') await sendFork($, a.prompt)
}

async function sendFork($, prompt: string): Promise<void> {
  forking = true
  let r
  try {
    r = await fork($, prompt)
  } finally {
    forking = false
  }
  const s = await cli($, 'forked', { fork: forkResult(r) })
  if (s?.action === 'turn') return submit($, s.text)
  if (s?.action === 'none') return reschedule($, s.dueInSec)
  // On `timer`, so a turn that ends meanwhile cancels it by arming its own.
  if (s?.action === 'retry' && timer === undefined) timer = $.clock.after(s.afterSec * 1000, () => void retryTick($))
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

/** As src/commands.ts has them (`isPingCommand`); the mod does not import the CLI's modules. */
const PING_COMMAND = '/cache-keeper:ping'
const PING_MARKER = '[cache-keeper:ping]'

/**
 * Is this turn `/cache-keeper:ping`'s? A command's turn begins with its tag
 * (`<command-name>/cache-keeper:ping</command-name>`, seen on 2.1.321); the
 * typed line and the command file's body are matched too.
 */
export function isPingTurn(text: string): boolean {
  const t = text.trim()
  if (t === PING_COMMAND || t.startsWith(`${PING_COMMAND} `)) return true
  // Anchored at the start, so a message that merely quotes the marker or the tag is a message.
  return t.startsWith(PING_MARKER) || (t.startsWith('<command-') && t.includes(`<command-name>${PING_COMMAND}</command-name>`))
}

/**
 * Called by gate.ts's `turn.step` hook for `/cache-keeper:ping`'s turn: the
 * text to answer it with, no model request, or undefined to let the turn
 * reach the model (commands/ping.md), which reads the cache as a wake turn.
 * That is also the way out when the CLI does not answer or the fork fails.
 */
export async function manualPing($): Promise<string | undefined> {
  // A ping already on its way (the timer's fork, say) is refused by the CLI: it holds the open ping.
  const a = await cli($, 'ping-now')
  if (a?.action === 'none') return a.text ?? 'cache-keeper: no ping sent.'
  if (a?.action !== 'fork') return undefined
  forking = true
  let r
  try {
    r = await fork($, a.prompt)
  } finally {
    forking = false
  }
  const s = await cli($, 'forked', { fork: forkResult(r) })
  // The fork failed and the CLI turned the ping into a turn: commands/ping.md answers it.
  if (s?.action === 'turn') return undefined
  if (s?.action === 'none' && s.text !== undefined) return s.text
  // The CLI did not record it: never a second request on top of a fork that went out.
  return r.isAnswered ? 'cache-keeper: pinged, but keeper could not record it.' : 'cache-keeper: no ping sent: the fork failed.'
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
