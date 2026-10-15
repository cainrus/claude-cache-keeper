# claude-cache-keeper

[![CI](https://github.com/cainrus/claude-cache-keeper/actions/workflows/ci.yml/badge.svg)](https://github.com/cainrus/claude-cache-keeper/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Keeps the prompt cache of an idle [Claude Code](https://docs.claude.com/en/docs/claude-code) session warm — but only while
someone is plausibly coming back to it. Pure Claude Code hooks: no proxy in the request path, no MCP server, no
background daemon, zero dependencies. TypeScript run directly by Node ≥ 22.18, no build step.

## The problem

Claude Code caches the conversation prefix with a **one-hour TTL** on a Claude subscription. A cache write costs
**2×** the base input price, a cache read **0.1×** — and a read refreshes the TTL. Leave a session idle for 61
minutes and the next turn rewrites the whole context: for a 200k-token Opus session that is about **$2.00** at API
list prices, against about **$0.10** for a read that would have kept it alive.

The read is easy. The hard part is **deciding when it is worth it**: most idle stretches are never resumed, and a
ping into a session nobody returns to is pure waste. This project is mostly that decision.

## How it works

```
Stop ──► record      (sync)   remember when the cache was last touched and how big it is
     └─► sleep 3000; wake     (asyncRewake) decide: exit 0 = let it go, exit 2 = ping
                               exit 2 wakes the model with a one-line message; it replies "ok"
UserPromptSubmit ──► touch     a real prompt closes the idle stretch (the wake's own prompt is ignored)
SessionEnd       ──► end       forget the session
```

The waiter is a plain `sleep`, so an idle session costs a ~1 MB process rather than a Node runtime. Every `Stop`
arms a new sleeper; when one wakes up and finds that a newer turn has happened since, it exits quietly. A wake turn
that reads the cache is a *hit*; one that had to rewrite it is a *miss* and mutes that session for good.

### Measured before writing the code

Claude Code 2.1.281, background session (`claude --bg`), hook declared in `.claude/settings.local.json`:

| observation | value |
|---|---|
| `Stop` hook fires in a background session | yes |
| exit 2 after a 45 s sleep wakes the idle session on its own | yes, the model replied `ok` |
| wake turn: cache read / written / output tokens | **57 129** / 911 / 91 — a **98.4 %** hit |
| the `Stop` closing the wake turn | arrives with `stop_hook_active: true` |

### Why hooks, and not the other designs

| design | failure mode | verdict |
|---|---|---|
| local HTTP proxy replaying the last request with `max_tokens: 0` | the proxy *is* the API endpoint: if it dies, every session dies | cheapest ping, unacceptable blast radius |
| plugin monitor printing a line | monitors start only in interactive CLI sessions, not `--bg` / agent view | misses the sessions that idle the most |
| MCP channel notification | needs `--channels` on the command line | cannot be enabled for daemon-spawned sessions |
| **`Stop` hook with `asyncRewake: true`** | the hook dies → no ping, the session is unaffected | **chosen** |

## How it decides

`src/policy.ts` is a pure function ported from a policy calibrated on 30 days of real usage (1 465 idle stretches,
89k main-thread turns). The first matching row refuses the ping and is what the ledger blames:

| # | refuse when | ledger reason | default |
|---|---|---|---|
| 1 | keyboard/mouse idle longer than `awaySec` | `away` | 1200 s |
| 2 | not at the keyboard (idle > `presenceSec`) and the machine-wide away budget is spent | `away-budget-spent` | 300 s, 6 pings |
| 3 | context smaller than `minCtxTokens` | `context-too-small` | 20 000 |
| 4 | cache older than `maxAgeSec` — a ping would pay a full write | `cache-expired` | 58 min |
| 5 | cache younger than `minAgeSec` | `cache-still-warm` | 50 min |
| 6 | `maxPings` already spent in this idle stretch | `budget-spent` | 4 |
| 7 | the previous ping missed the cache | `oracle-miss` | — |
| 8 | the `skipIf` command exits 0 | `skip-if` | not set |

- **`skipIf`** is the hook for knowledge the keeper does not have: that a session's task is finished, handed off or
  not worth coming back to. It runs through `/bin/sh` only for a ping that passed every other row, with
  `CACHE_KEEPER_SESSION_ID`, `CACHE_KEEPER_TRANSCRIPT_PATH` and `CACHE_KEEPER_LAST_PROMPT_AT` (ISO, empty when
  unknown) in its environment. Only exit 0 skips; a failing, missing or slow (> 5 s) command lets the ping out, so a
  broken probe falls back to the keeper's own behaviour. Compare `LAST_PROMPT_AT` with your own "done" timestamp to
  let a session be kept again once someone writes to it after the fact.
- **Presence** is macOS `HIDIdleTime`, which keeps counting through a closed lid or a locked screen. Elsewhere, or
  when the probe fails, presence is *unknown*: the `away` gate lets it through, but the away budget treats it as
  "not at the keyboard", so a broken probe can never lift the only machine-wide cap.
- **The away budget** is one small file shared by every session on the machine, refilled whenever presence is seen.
  Without it, the spend of one absence would grow with the number of open sessions.
- **The per-stretch cap** (4 pings ≈ four hours) covers "I was at the computer but never went back to that session":
  it is reset only by a real prompt in that session.

The full rationale is in [docs/DESIGN.md](docs/DESIGN.md).

## Install

Requires Node **≥ 22.18** on `PATH` (runs `.ts` natively) and a POSIX shell. macOS gives the best presence signal;
Linux works with presence unknown (see above).

### As a plugin

```sh
claude plugin marketplace add cainrus/claude-cache-keeper
claude plugin install cache-keeper@claude-cache-keeper
```

Hooks are read at session start, so new sessions — including background and agent-view sessions — pick it up.

### Without the plugin system

```sh
git clone https://github.com/cainrus/claude-cache-keeper.git
node claude-cache-keeper/bin/cache-keeper.ts install-snippet
```

This prints a `hooks` block with absolute paths; merge it into `~/.claude/settings.json` (or a project settings file).

## Configuration

Environment variables (set them in the `env` block of your Claude Code settings so hooks inherit them) override
`$CACHE_KEEPER_HOME/config.json`, which overrides the defaults. The JSON keys are the names in the first column.

| key | env | default | meaning |
|---|---|---|---|
| — | `CACHE_KEEPER_DELAY_SEC` | `3000` | how long the waiter sleeps after each turn; keep it between `minAgeSec` and `maxAgeSec` (env only: the shell reads it) |
| — | `CACHE_KEEPER_HOME` | `~/.claude-cache-keeper` | state, ledger and `config.json` |
| `enabled` | `CACHE_KEEPER_DISABLED=1` | `true` | master switch |
| `awaySec` | `CACHE_KEEPER_AWAY_SEC` | `1200` | idle longer than this = gone |
| `presenceSec` | `CACHE_KEEPER_PRESENCE_SEC` | `300` | idle up to this = at the keyboard |
| `maxAwayPings` | `CACHE_KEEPER_MAX_AWAY_PINGS` | `6` | machine-wide pings per absence |
| `minCtxTokens` | `CACHE_KEEPER_MIN_CTX_TOKENS` | `20000` | smallest context worth holding |
| `minAgeSec` | `CACHE_KEEPER_MIN_AGE_SEC` | `3000` | earliest ping |
| `maxAgeSec` | `CACHE_KEEPER_MAX_AGE_SEC` | `3480` | latest ping |
| `maxPings` | `CACHE_KEEPER_MAX_PINGS` | `4` | pings per idle stretch |
| `hitRatio` | `CACHE_KEEPER_HIT_RATIO` | `0.9` | wake turn counts as a hit at `read / (read + write) ≥` this |
| `prices` | — | opus 5, sonnet 3, haiku 1 | USD per million base input tokens, for `report` |
| `skipIf` | `CACHE_KEEPER_SKIP_IF` | — | shell command asked before each ping; exit 0 skips it (see [How it decides](#how-it-decides)) |
| — | `CACHE_KEEPER_IDLE_SEC` | — | override the presence probe (a number of seconds, or `unknown`) |
| `handoff.enabled` | `CACHE_KEEPER_HANDOFF` | `false` | write a brief before the cache dies and ask before a prompt hits it cold (see [Handoff](#handoff)) |
| `handoff.*` | | | see [Handoff](#handoff) |

The defaults assume the 1-hour TTL of a subscription. On an API key the TTL is 5 minutes unless configured
otherwise; the first ping will then miss and the oracle will mute the session, which is safe but useless.

## Handoff

Opt-in, off by default.

When the keeper stops holding a session (`away`, `away-budget-spent`, `budget-spent`) its cache is usually still
warm. With `handoff` on, it spends that last warm turn asking the model to write a self-contained brief for a new
session to `$CACHE_KEEPER_HOME/handoffs/<session>.md`. The transcript is not touched.

When you come back after the cache has expired, your first prompt is stopped by the `UserPromptSubmit` hook before
it reaches the model (no cold rewrite yet) and goes back to the input box, with a menu:

```
cache-keeper: this session's prompt cache has gone cold (idle 2h 10m); the next turn re-sends ~151k tokens (≈ $1.51).
A handoff brief was written before it expired: ~/.claude-cache-keeper/handoffs/<session>.md
  Enter  send the same message again to continue here (or type 1)
  2      continue in a new session from the brief, with your message; this session closes
Your message is held and is back in the input box. Nothing was sent to the model.
```

- **Enter** (the same text again), `1` or `force`: the prompt goes through and pays the rewrite. With `1` the held
  message is passed to the model as context.
- **`2`**: the brief plus your held message are written to `handoffs/<session>-continue.md` and `spawnCommand` is
  run with it; its output (say, the new session's id) is shown. On exit 0 this session is closed two seconds later.
  Without `spawnCommand`, only the file is written.
- Anything else replaces the held message and shows the menu again.
- Back before the cache expired: nothing is intercepted and the brief is retired.

`!` commands and slash commands do not go through `UserPromptSubmit` (Claude Code 2.1.299), so they reach a cold
cache without the menu.

| `handoff.` key | env | default | meaning |
|---|---|---|---|
| `enabled` | `CACHE_KEEPER_HANDOFF` | `false` | switch |
| `minCtxTokens` | `CACHE_KEEPER_HANDOFF_MIN_CTX_TOKENS` | `120000` | below this a brief saves too little |
| `spawnCommand` | `CACHE_KEEPER_HANDOFF_SPAWN` | — | shell command starting a new session; gets `CACHE_KEEPER_BRIEF`, `CACHE_KEEPER_SESSION_ID`, `CACHE_KEEPER_TRANSCRIPT_PATH`, `CACHE_KEEPER_CWD`; 45 s at most |
| `closeAfterSpawn` | `CACHE_KEEPER_HANDOFF_CLOSE` | `true` | close the old session after a successful spawn |
| `closeCommand` | — | SIGTERM to the session's `claude` | how to close it; gets `CACHE_KEEPER_SESSION_ID`, `CACHE_KEEPER_CLAUDE_PID` |

Example: `"spawnCommand": "claude-new-session --prompt-file \"$CACHE_KEEPER_BRIEF\" --cwd \"$CACHE_KEEPER_CWD\""` —
any launcher that starts a session in the background and returns.

## Report

Every decision is one line in `$CACHE_KEEPER_HOME/ledger.jsonl`. `cache-keeper report` (or `--json`) summarises it.
Illustrative output from a synthetic ledger:

```
$ node bin/cache-keeper.ts report
cache-keeper report  2026-09-01T09:07 .. 2026-09-01T16:28  (64 ledger lines)

pings
  sent                          10
  cache hits                     9
  cache misses                   1
  not scored                     0

idle stretches with a ping
  resumed                        6
    while still warm             6
  abandoned                      4

refusals                        38
  away                          21
  away-budget-spent              2
  context-too-small              7
  cache-expired                  4
  budget-spent                   3
  oracle-miss                    1

estimate at API list prices
  rewrites avoided           $8.98
  ping cost                  $1.50
  balance                   +$7.47
```

"Rewrites avoided" counts only stretches resumed while the held cache was still alive, valued as a 1h cache write
of the whole context minus the read paid instead. On a subscription nothing is billed per token, but the same
tokens count against usage limits.

## Limitations

- **A session blocked on its own long tool call is not held.** `Stop` does not fire mid-turn.
- **The 5-hour usage window is invisible.** Hooks never see response headers, so the keeper cannot back off when
  the window is nearly full.
- **Each wake is a real (tiny) turn.** It appears in the transcript and runs your other `UserPromptSubmit` hooks;
  their output is part of the ~1k tokens a wake writes.
- **`claude -p` is skipped on purpose.** In print mode async hooks are not backgrounded, so the waiter would hold
  a one-shot run open; it detects `CLAUDE_CODE_ENTRYPOINT=sdk-cli` and returns at once.
- **No Windows support** — the waiter uses POSIX `sleep`.
- Presence is macOS-only; on other systems the away budget is the only cap while you are away.

## Development

```sh
npm test                           # node --test, no dependencies
node bin/cache-keeper.ts --help
```

The tests cover every policy branch and the branch order, the presence parser, the away budget, the oracle against
fixture transcripts, the report math, and an end-to-end run of the exact `hooks/hooks.json` commands through `bash`
with a temp state directory, a fake transcript and a presence override — no network, no Claude Code, any OS.

## License

[Apache-2.0](LICENSE) © 2026 Sergei Tarassov
