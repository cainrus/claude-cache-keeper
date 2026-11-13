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
                               exit 2 wakes the model with a one-line message; it replies "ok" (or what it is waiting for)
UserPromptSubmit ──► touch     a real prompt closes the idle stretch (the wake's own prompt is ignored)
SessionEnd       ──► end       forget the session
turn.complete (mod) ──► arm    where the plugin's mod loads: claim the stretch, ping by fork instead (see Fork pings)
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
| 0 | you ran [`/cache-keeper:done`](#done-with-a-session) in this session | `done` | — |
| 1 | keyboard/mouse idle longer than `awaySec` | `away` | 1200 s |
| 2 | not at the keyboard (idle > `presenceSec`) and the machine-wide away budget is spent | `away-budget-spent` | 300 s, 6 pings |
| 3 | context smaller than `minCtxTokens` | `context-too-small` | 20 000 |
| 4 | cache older than `maxAgeSec` — a ping would pay a full write | `cache-expired` | 58 min |
| 5 | cache younger than `minAgeSec` | `cache-still-warm` | 50 min |
| 6 | `maxPings` already spent in this idle stretch | `budget-spent` | 4, then [tuned](#the-cap-tunes-itself) |
| 7 | the previous ping missed the cache | `oracle-miss` | — |
| 8 | the `skipIf` command exits 0 | `skip-if` | not set |
| 9 | the `skipIf` command exits 3 and no [handoff](#handoff) is due | `holder` | not set |

- **`skipIf`** is the hook for knowledge the keeper does not have: that a session's task is finished, handed off or
  not worth coming back to. It runs through `/bin/sh` only for a ping that passed every other row (or a handoff that
  is due), with `CACHE_KEEPER_SESSION_ID`, `CACHE_KEEPER_TRANSCRIPT_PATH` and `CACHE_KEEPER_LAST_PROMPT_AT` (ISO,
  empty when unknown) in its environment. Exit 0 skips. Exit 3 says *someone else holds this session and would rather
  continue in a new one than keep this one warm* (an orchestrator that started it): no ping, and a
  [handoff](#handoff) with no menu when one is due. A failing, missing or slow (> 5 s) command lets the ping out, so a
  broken probe falls back to the keeper's own behaviour. Compare `LAST_PROMPT_AT` with your own "done" timestamp to
  let a session be kept again once someone writes to it after the fact.
- **Presence** is macOS `HIDIdleTime`, which keeps counting through a closed lid or a locked screen. On Linux the
  first of these that answers: GNOME's Mutter idle monitor, the freedesktop `ScreenSaver` interface (KDE),
  `xprintidle` (X11), then logind's idle hint (`loginctl show-user`, trusted only while you have a graphical
  session, and only as fine as your desktop's idle delay). Elsewhere, or when no probe answers, presence is *unknown*: the `away` gate lets it through, but the away budget treats it as
  "not at the keyboard", so a broken probe can never lift the only machine-wide cap.
- **The away budget** is one small file shared by every session on the machine, refilled whenever presence is seen.
  Without it, the spend of one absence would grow with the number of open sessions.
- **The per-stretch cap** (4 pings ≈ four hours to start with) covers "I was at the computer but never went back to
  that session": it is reset only by a real prompt in that session.

### The cap tunes itself

Unless you set `maxPings`, the keeper moves it by the ledger. The k-th ping of a stretch pays off when you come back
while its cache is still warm, so it is worth sending while that happens more often than the ping costs relative to
the rewrite it avoids (the breakeven, measured from the ledger too: 5.9 % on the author's machine). Above the cap
nothing is observed, so the cap learns by trying one more. Once a day, with at least 30 pings at the cap's position
in the last 60 days, it goes up a step when that position kept 2× breakeven warm and down a step when it kept less
than breakeven, within [2, 8]. On the author's ledger the 4th ping kept 17.9 % warm, so the first step is 4 → 5.
`cache-keeper report` prints the current cap and why; the decision is kept in `$CACHE_KEEPER_HOME/tuning.json`.

### Done with a session

Type `/cache-keeper:done` (plugin install) when you know you will not come back to a session. The hook answers it
and blocks it, so it costs no model request, and the session gets no more pings or handoff. Your next message in
that session lifts it. For a rule rather than a one-off, use `skipIf`.

### Status and a ping by hand

`/cache-keeper:status` shows what keeper knows of this session (cached till when, pings used, the context size,
whether pings go as forks, a missed ping or a mute) and every setting in force with where it came from: `env`,
`config.json`, `tuned` (the cap) or `default`. It warns about settings that leave keeper unable to ping at all
(`minAgeSec` not below `maxAgeSec`, or `CACHE_KEEPER_DELAY_SEC` outside them). The hook answers it, so it costs no
model request.

`/cache-keeper:ping` renews the cache now, say before a meeting, without waiting for keeper's timer. Where the
plugin's mod loads, a [fork](#fork-pings) answers it: the reply says how many tokens it read from the cache and until
when the cache is warm. It refuses, at no cost, when nothing is cached yet, the cache already expired, a compaction
left nothing to hold, or a ping is already on its way. Without the mod (or with `"forkPings": false`) the command
reaches the model as a one-word turn, which reads the cache too. A ping by hand is outside keeper's budgets and is not
scored: a cold one does not mute the session, and the tuner never sees it. The ledger logs it as `manual-ping`, and
its cost is in the report's ping cost.

A [handoff](#handoff) turn is no ping either: it writes the brief, so its cost is in the report's ping cost, but it is
not counted as a hit or a miss and a miss does not mute the session.

The full rationale is in [docs/DESIGN.md](docs/DESIGN.md).

## Results on one machine

The author's own ledger, 2026-09-25 to 2026-10-28 (33 days): two Claude Code profiles on one Mac, mostly Opus,
interactive and background sessions.

```
pings
  sent                        1245
  cache hits                  1191
  cache misses                   3
  not scored                    51

idle stretches with a ping
  resumed                      459
    while still warm           359
    paid turn measured           0
    held, not used               0
  abandoned                    182

estimate at API list prices
  rewrites avoided         $998.33
  ping cost                $180.18
  balance                 +$818.15
```

3 misses out of 1194 scored pings: a ping almost never arrives to find the cache already gone. The 182 stretches
that were pinged and never resumed are counted in the ping cost. The saving is an estimate: each stretch resumed
while warm is valued as a full 1h rewrite of its context. Measured savings (see [Report](#report)) start with 0.4.0,
so this ledger has none yet. On a subscription the balance is usage-limit headroom, not money.

## Install

Requires Node **≥ 22.18** on `PATH` (runs `.ts` natively; on the 23 line, 23.6+) and a POSIX shell. macOS gives the
best presence signal; Linux desktops are covered by the probes above, and a headless Linux box runs with presence
unknown.

**Node is not part of Claude Code.** The native installer is one binary with no Node in it, and `/plugin install`
checks none. So every hook enters through `bin/cache-keeper.sh`, which checks `node --version` first: with no Node,
or one too old, keeper does nothing and never shows a hook error. Each new session then opens with one line saying
why, and once per machine for each kind of problem (no Node, too old, no version printed), on a fresh interactive
start, Claude is told to offer, after your first request, to set Node up with the version manager already on the
machine. Say no and it is not raised again. Keeper turned off (`CACHE_KEEPER_DISABLED`, `"enabled": false`) says
nothing. Keeper itself never installs anything. With mods, the status line shows `error: needs Node.js ≥ 22.18` too.

```sh
node --version   # v22.18.0 or later
```

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
| `maxPings` | `CACHE_KEEPER_MAX_PINGS` | auto, from `4` | pings per idle stretch; setting it turns the [tuning](#the-cap-tunes-itself) off |
| `hitRatio` | `CACHE_KEEPER_HIT_RATIO` | `0.9` | wake turn counts as a hit at `read / (read + write) ≥` this; a value above 1 is ignored |
| `prices` | — | per model, list prices of 2026-11-03 (`src/prices.ts`) | USD per million tokens, for `report` and the handoff menu: `{"claude-opus-5-5": {"input": 4, "cacheRead": 0.2, "cacheWrite": 8, "output": 20}}` per model id prefix, or a number for a family (`"opus": 5`: input, with 0.1× read, 2× write, 5× output). No Anthropic API serves prices, so the table is kept by hand; `report` names any model it has no row for |
| `skipIf` | `CACHE_KEEPER_SKIP_IF` | — | shell command asked before each ping or due handoff; exit 0 skips, exit 3 hands off (see [How it decides](#how-it-decides)) |
| — | `CACHE_KEEPER_IDLE_SEC` | — | override the presence probe (a number of seconds, or `unknown`) |
| `handoff.enabled` | `CACHE_KEEPER_HANDOFF` | `false` | write a brief before the cache dies and ask before a prompt hits it cold (see [Handoff](#handoff)) |
| `handoff.*` | | | see [Handoff](#handoff) |
| `statusLine` | — | `true` | show the cache line under the prompt (see [Status line](#status-line)) |
| `forkPings` | `CACHE_KEEPER_FORK` | `true` | ping with a fork instead of a wake turn where the plugin's mod loads (see [Fork pings](#fork-pings)) |
| `cacheTtlSec` | — | `3600` | the cache TTL the status line, `/cache-keeper:status`, `/cache-keeper:ping` and the report assume; change it only if yours is not one hour |

The defaults assume the 1-hour TTL of a subscription. On an API key the TTL is 5 minutes unless configured
otherwise; the first ping will then miss and the oracle will mute the session, which is safe but useless.

## Status line

Installed as a plugin, keeper pins one line under the prompt (Claude Code shows it as `⚠ cache-keeper: …`):

- `ready`: keeper is on; nothing has been sent in this session yet.
- `cached till 14:05 · renews ×3`: the cache stays warm until 14:05, and keeper can extend it; 3 is how many pings
  it has left in this stretch. A ping still needs you back within `awaySec` and the away budget unspent: the line
  cannot see your keyboard, so away longer than that, 14:05 is final after all.
- `cached till 14:05`: no ping is coming (none left, the context is too small to hold, the session is muted, or a
  ping missed), so 14:05 is final.
- `cache expired`: the cache went cold; the next turn rewrites the whole context.
- `error: needs Node.js ≥ 22.18`: `node` on `PATH` is missing or too old to run the hooks, so keeper does nothing.
- `error: record failed · ~/.claude-cache-keeper/errors.log`: a hook of this session threw. Hooks still exit 0 (a
  session is never broken by keeper), but each failure is now logged there, counted by `report`, shown by
  `/cache-keeper:status`, and, without mods, told once an hour on the session's next prompt. The line goes away once a
  turn is recorded cleanly.

It comes from keeper's own session record, refreshed a few seconds after each turn and every 30 s; Node is checked
once when the session starts. It is a line of its own, not part of your `statusLine` command: Claude Code gives plugins no
way into that slot. If your `statusLine` already shows keeper, set `"statusLine": false` in `config.json`.

## Fork pings

Installed as a plugin on a Claude Code with mods, keeper pings with `$.model.fork` instead of a wake turn. A fork
replays the session's last request with one short question after it: the API reads the prefix from the cache, which
renews it, and nothing is added to the transcript, so no other hook runs and the model never sees a ping.

- The plugin's mod claims each idle stretch when a turn ends (`$CACHE_KEEPER_HOME/forks/<session>.json`) and runs its
  own timer. The `Stop` sleeper finds the claim and stands down, so a stretch gets a fork or a wake turn, never both.
- Every decision stays the CLI's: the same policy, budgets, tuning and ledger as a wake turn. The ledger marks a fork
  ping with `"transport": "fork"`, and scores it from the fork's own usage.
- A fork that brings no reply (a timeout, an API error) is sent again after a minute, up to twice, while a re-sent
  fork can still land under `maxAgeSec`; then it falls back to the wake turn. `nothing-to-fork` (right after
  `--resume`) goes to the wake turn at once. Past `maxAgeSec` nothing goes out: a request that late finds the cache
  gone and writes the whole prefix again, which the person's next turn would pay anyway. The ledger's `fork-failed`
  line says which (`"next": "retry" | "turn" | "drop"`).
- Where the mod does not load (no mods, an older Claude Code) nothing claims the stretch and the sleeper pings with a
  wake turn as before. `"forkPings": false` or `CACHE_KEEPER_FORK=0` does the same on purpose.
- A fork renews the cache on the server but not Claude Code's own idea of when it last sent a request
  ([anthropics/claude-code#105017](https://github.com/anthropics/claude-code/issues/105017)): a compaction after an
  hour held by forks alone would send the whole context uncached. So `/compact` (or a plugin's compaction) in such a
  stretch is put off behind one wake turn, which reads the warm cache, and runs right after it.

- After a compaction nothing of the new context is cached until a turn sends it, so there is nothing to hold:
  keeper sends no ping until the next turn (ledger reason `compacted`).

Measured on Claude Code 2.1.316 with a subscription (1-hour cache TTL):

| observation | value |
|---|---|
| a marketplace install loads the plugin's mod, no opt-in | yes (`hooks module cache-keeper@claude-cache-keeper loaded`) |
| fork ping 90 s after a turn: cache read / written / input | 58 435 / 3 088 / 4 (Sonnet) |
| the next fork ping | 61 523 / 0 / 4 |
| fork at +55 min after the only turn, then at +65 min: cache read | 59 362, then 59 362 (Haiku; the turn's own 1-hour write expired at +60) |
| the `Stop` sleeper while the mod holds the stretch | stands down; no wake turn in the transcript |
| a fork right after `/compact`, before any turn | 26 833 read, 42 164 sent uncached: why keeper skips it |

The fork re-reads the cached prefix and so renews it for another hour; only its own short tail (the last answer and
the question) is written, at the 5-minute TTL, and written again by the next fork.

## Handoff

Opt-in, off by default.

When the keeper stops holding a session (`away`, `away-budget-spent`, `budget-spent`) its cache is usually still
warm. With `handoff` on, it spends that last warm turn asking the model to write a self-contained brief for a new
session to `$CACHE_KEEPER_HOME/handoffs/<session>.md`. The transcript is not touched.

A session with a task list first brings it up to date (`TaskUpdate`), then copies every open step with its status
under `## Task list` in the brief. When the new session starts from that brief, it is told to recreate those steps
with `TaskCreate` before anything else, so the plan carries over instead of starting from scratch.

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

A session whose `skipIf` answered exit 3 (it has a holder) is not asked: the brief is written at the point the keeper
would have pinged, and the first prompt into the cold cache goes straight to `2`. Its sender is a session, not a person
at the input box, so there is nobody to read a menu. `skipIf` is asked again at that prompt: if it no longer answers 3
(the holder left or ended), the prompt gets the menu. So do a gate turn (it may be a task notification of a session in
the middle of its work) and any prompt after a failed start.

A **background session** (Claude Code set `CLAUDE_JOB_DIR` for it, or its transcript says `"sessionKind":"bg"`;
`CACHE_KEEPER_BACKGROUND=0|1` overrides) has nobody at its input box either. There a message from another session
(`<cross-session-message …>`) or a `<task-notification>` is never held: it continues here and pays the rewrite, as
the work it carries was asked for, and the ledger records `handoff-here` with `detail: "unattended"`. A held session
does not hand off on it either, since the sender would go on writing to a closed session. A message the menu held
before reaches the model with it (as a notice on a gate turn). Anything else typed there still gets the menu.

Skills (`/simplify`) go through `UserPromptSubmit` like any prompt, but `!` commands and built-in slash commands never
do (measured on Claude Code 2.1.301), so the plugin also ships a small hooks module, `hooks/gate.ts`, that asks `cache-keeper gate` where such
input does reach the model, and shows the same menu:

| input | hook | what the menu does |
|---|---|---|
| `!cmd` | `turn.step` (first request of a turn) | answers the turn itself; no request is sent. The command already ran |
| `/compact` | `session.compact` | skips the compaction |
| `/cache-keeper:ping` | `turn.step` | not the menu: a fork answers the turn (see [Status and a ping by hand](#status-and-a-ping-by-hand)) |
| `/cost`, `/model`, `/status`… | — | make no model request; not gated (`/cache-keeper:status` is answered by `UserPromptSubmit`) |

"The same message again" means the same command again (for `!` the held text is the command's output, so re-running
it matches). The module is loaded only when the keeper is installed as a plugin; the `install-snippet` form has no
module, so there `!` and slash commands still reach a cold cache unasked.

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
    paid turn measured           6
    held, not used               0
  abandoned                      4

refusals                        38
  away                          21
  away-budget-spent              2
  context-too-small              7
  cache-expired                  4
  budget-spent                   3
  oracle-miss                    1

at API list prices (measured where paid, estimated elsewhere)
  rewrites avoided           $8.98
  ping cost                  $1.50
  balance                   +$7.47
```

"Rewrites avoided" values each resumed stretch by what the first request of the resumed turn really paid: a 1h
cache write of the whole context, minus that payment (`resume-paid` in the ledger). The first request, not the
last: when it rewrites the context, every later request of the turn reads that fresh write and looks like a hit.
A resume into a cache that was gone after all comes out at about zero, and "held, not used" counts those: pings
that bought nothing. A resume with no measured payment (an older ledger, a transcript that never caught
up) falls back to the estimate, counted only while the held cache was still alive. On a subscription nothing is
billed per token, but the same tokens count against usage limits.

## Limitations

- **A session blocked on its own long tool call is not held.** `Stop` does not fire mid-turn.
- **The 5-hour usage window is invisible.** Hooks never see response headers, so the keeper cannot back off when
  the window is nearly full.
- **Without the mod, each wake is a real (tiny) turn.** It appears in the transcript and runs your other
  `UserPromptSubmit` hooks; their output is part of the ~1k tokens a wake writes. [Fork pings](#fork-pings) avoid
  that where the plugin's mod loads.
- **`claude -p` is skipped on purpose.** In print mode async hooks are not backgrounded, so the waiter would hold
  a one-shot run open; it detects `CLAUDE_CODE_ENTRYPOINT=sdk-cli` and returns at once.
- **No Windows support** — the waiter uses POSIX `sleep`.
- Presence needs a desktop: on a headless Linux box, or a session started without its desktop's session bus, only
  logind can answer, and without a graphical session nobody does; then the away budget is the only cap while you are
  away. A desktop with its idle delay off never sets logind's hint, so there the precise probes are the only signal.

## Development

```sh
npm test                           # node --test, no dependencies
node bin/cache-keeper.ts --help
```

The tests cover every policy branch and the branch order, the presence probes (macOS and each Linux one, with fake
commands, plus the real probe of the machine they run on), the away budget, the cap tuner, the oracle against fixture
transcripts, the report math, and an end-to-end run of the exact `hooks/hooks.json` commands through `bash` with a
temp state directory, a fake transcript and a presence override — no network, any OS.

- `test/fixtures/real-shapes.jsonl` carries the line shapes Claude Code really writes (compaction, API errors,
  `system` and `attachment` lines, junk roots, a torn tail) with invented content. It is generated by
  `make-real-shapes.ts`, and a test checks the two agree.
- `test/concurrency.test.ts` races eight processes on the ledger and on one session file.
- `test/plugin.test.ts` runs `claude plugin validate --strict` on the plugin and the marketplace when a `claude`
  binary is on `PATH` (or in `CLAUDE_BIN`) and is skipped otherwise; CI runs it on a pinned Claude Code.

## License

[Apache-2.0](LICENSE) © 2026 Sergei Tarassov
