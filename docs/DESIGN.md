# claude-cache-keeper — design

Keeps the prompt cache of an idle Claude Code session warm, but only while
someone is plausibly coming back to it. Pure Claude Code hooks: no proxy in the
request path, no MCP server, no plugin monitor, zero runtime dependencies.

## The problem

Claude Code's main conversation caches its prompt prefix with a **one-hour TTL**
on a Claude subscription (five minutes on an API key unless `promptCacheTtl` is
set). A cache write costs 2x base input for the 1h TTL; a cache read costs 0.1x
and **refreshes the TTL**. A session left idle for 61 minutes pays a full rewrite
of its whole context on the next turn — for a 200k-token Opus session that is
the most expensive turn of the day, and it buys nothing.

A cheap read before the hour runs out avoids the rewrite. The hard part is not
the read, it is **deciding when a read is worth it**: most idle stretches are
never resumed, and a ping into a session nobody returns to is pure waste.

## Why hooks, and not the other designs

| design | how it pings | failure mode | verdict |
|---|---|---|---|
| local HTTP proxy replaying the last request with `max_tokens: 0` | a byte-exact read, zero output | the proxy IS the API endpoint: if it dies, every session dies | cheapest ping, unacceptable blast radius |
| plugin monitor (`experimental.monitors`) printing a line | wakes the session for a real turn | monitors only start in interactive CLI sessions, not `--bg` / agent-view | misses the sessions that idle the most |
| MCP channel notification | wakes the session | needs `--channels` on the command line — a flag, not a setting | cannot be enabled for daemon-spawned sessions |
| **`Stop` hook with `asyncRewake: true`** | the hook sleeps, then exits 2; Claude Code wakes the model with the hook's stderr | the hook dies → no ping, session unaffected | **chosen** |

Measured before writing a line of code (Claude Code 2.1.281, background session
started with `claude --bg`, hook declared in project `.claude/settings.local.json`):

- the `Stop` hook fired in the background session;
- 45 s later it exited 2 and the session woke on its own ("Stop hook feedback"),
  the model replied `ok`;
- the wake turn read **57 129** tokens from cache, wrote **911**, output **91** —
  a 98.4 % hit; the writes are the wake message plus whatever other
  `UserPromptSubmit` hooks the user has installed;
- the `Stop` that closes the wake turn arrives with `stop_hook_active: true`.

Per the hooks reference, `timeout` is not enforced on async hooks, so a hook may
sleep for most of an hour.

## Mechanism

Two `Stop` hooks and one `UserPromptSubmit` hook, all the same entry point
(`bin/cache-keeper.ts`) with a subcommand:

1. **`Stop` → `record`** (synchronous, fast). Reads the hook input, reads the
   last assistant `usage` from `transcript_path`, updates the session state:
   `lastTurnEndAt`, `ctxTokens` (= input + cache_read + cache_creation of the
   last main-thread response), and — when this Stop closes a wake turn
   (`stop_hook_active` or `pendingPing`) — the **ping oracle**: the wake was a
   hit when `cache_read / (cache_read + cache_creation) >= 0.9`. A miss sets
   `lastPingHit = false`, which stops further pings to this session.
2. **`Stop` → `wait`** (`asyncRewake: true`). The command is
   `sleep <delay>; node …/cache-keeper.ts wake` so that an idle session costs a
   ~1 MB `sleep` process, not a 40 MB node process. Hook input stays unread on
   stdin during the sleep and is consumed by `wake` afterwards.
3. **`wake`** re-reads state. If a newer turn has ended since (`now -
   lastTurnEndAt < minAgeSec`), this sleeper is stale: exit 0. Otherwise it
   builds the policy input, calls `decide()`, appends a ledger line, and either
   exits 0 (no ping) or sets `pendingPing`, increments `pingsSoFar` and exits 2
   with the wake message on stderr.
4. **`UserPromptSubmit` → `touch`** resets `pingsSoFar`, sets `lastHumanAt`,
   and closes the idle stretch in the ledger as `resumed` (was the last ping
   useful: the stretch had ≥1 ping and ended with a real prompt). The wake turn
   also fires `UserPromptSubmit`; it is recognised by the wake marker in
   `prompt` and ignored.
5. **`SessionEnd` → `end`** deletes the session state.

The wake message is fixed, one line; its second half (`WAKE_REPLY`, `src/wake-text.ts`) also ends
the handoff wake:

```
[cache-keeper] Prompt-cache keep-alive. Reply with one short line and no further tools: "ok", or "ok, waiting for <what>" while anything is pending (background work, an answer). This wake is not a stop: an open task stays open, and whatever this session waits for still resumes it.
```

Why not a bare "ok": a wake often lands on a session that is idle only because it waits for
something (a queued bench run, a CI wait, an answer it asked for). A bare "ok" then becomes its last turn, and whoever
watches the session (a human, an orchestrating session, a job status line) reads "idle, done" and
nudges a session that was about to resume on its own. A reply that names the wait keeps it visible
for a few output tokens. Every wake that lands in the transcript carries this text, including the
turn a fork ping falls back to; the fork itself keeps a bare "ok", since its answer is never
recorded.

## Policy (`src/policy.ts`, pure)

Ported from a policy that was calibrated on 30 days of real usage (1 465
historical idle stretches, 89k main-thread turns). Branch order is the policy:
it decides which reason the ledger blames.

| # | refuse when | reason | default |
|---|---|---|---|
| 0 | the human ran `/cache-keeper:done` in this session (lifted by their next prompt) | `done` | — |
| 1 | human away longer than `awaySec` (keyboard/mouse idle) | `away` | 1200 s |
| 2 | human not at keyboard (> `presenceSec`) and the machine-wide away budget is spent | `away-budget-spent` | 300 s, 6 pings |
| 3 | context smaller than `minCtxTokens` | `context-too-small` | 20 000 |
| 4 | cache already older than `maxAgeSec` (a ping would pay a full write) | `cache-expired` | 58 min |
| 5 | cache younger than `minAgeSec` | `cache-still-warm` | 50 min |
| 6 | `pingsSoFar >= maxPings` in this idle stretch | `budget-spent` | 4, then tuned |
| 7 | the previous ping missed the cache | `oracle-miss` | — |

- **Presence** is macOS `HIDIdleTime` (`ioreg -c IOHIDSystem`), which also
  covers a closed lid and a locked screen. On Linux a chain, first answer wins:
  Mutter `GetIdletime`, freedesktop `ScreenSaver.GetSessionIdleTime`,
  `xprintidle`, then `loginctl show-user` (`IdleHint` / `IdleSinceHint`). The
  first three need the desktop's bus or display, which a daemon-spawned session
  may not inherit; logind needs neither, but is trusted only with a graphical
  session (`Display=`), since without a desktop the hint can stay "not idle"
  forever and would lift the away budget. Each probe gets 2 s. On other
  platforms, or when nothing answers, presence is `null`: gate 1 passes (unknown is not "gone"), gate 2
  treats it as *not* at the keyboard — the only machine-wide cap must not be
  lifted by a broken probe.
- **Away budget** is one small JSON file for the whole machine
  (`awayPingsSincePresence`, refilled whenever presence ≤ `presenceSec` is
  observed). Without it, the spend of one absence grows with the number of open
  sessions. Writes are atomic (`write tmp + rename`); a lost increment under a
  race costs one extra ping, never an unbounded number.
- **Per-stretch cap** (`maxPings`, 4 ≈ four hours of holding to start with) is the answer to
  "I was at the computer but never went back to that session": the counter is
  reset only by a real prompt in *this* session.
- **The cap tunes itself** (`src/tune.ts`) unless `maxPings` is set. The k-th
  ping pays off when the stretch resumes warm right after it, so it is worth
  sending while `P(warm resume after ping k | ping k sent) >= breakeven`, and
  breakeven is the mean wake cost over the rewrite it avoids, both from the
  ledger (5.9 % on the author's). Nothing above the cap is ever observed, so
  the cap learns by trying one more: once a day, on at least 30 pings at the
  cap's position from the last 60 days, it goes up a step when that position
  clears 2× breakeven and down a step when it does not clear breakeven, inside
  [2, 8]. The decision is kept in `tuning.json`; `report` prints it.
- Every threshold is overridable through env (`CACHE_KEEPER_*`) and a JSON
  config file; tests assert behaviour against the exported constants, never the
  numbers.

## State and ledger

`$CACHE_KEEPER_HOME`, default `~/.claude-cache-keeper/`:

- `sessions/<session_id>.json` — per-session state (above);
- `away-budget.json` — the machine-wide bucket;
- `ledger.jsonl` — one line per decision: `{t, sessionId, event: ping|skip|resume|wake-hit|wake-miss, reason?, ctxTokens?, ageSec?}`.

`cache-keeper report` summarises the ledger: pings, hits, misses, stretches
resumed after a ping vs abandoned, refusals by reason, and an estimated balance
(saved rewrites − ping cost) from the recorded token counts and a price table.

## Install

As a plugin (`.claude-plugin/plugin.json` + `hooks/hooks.json`, marketplace in
the same repo), or by pasting the hooks block into any settings file. Hooks are
read from disk at session start, so both reach background and agent-view
sessions.

## Non-goals

- Holding the cache for sessions blocked on their own tool call (Stop does not
  fire mid-turn); a later version can track background work via `PostToolUse`.
- Reading the 5-hour usage window: hooks never see response headers.
- Windows (the waiter uses POSIX `sleep`).
