#!/bin/sh
# Every hook command enters here. With a node on PATH that runs .ts natively it
# hands over to cache-keeper.ts; without one it does nothing and exits 0, so a
# session never shows a hook error and is never held up by keeper.
#
# Claude Code brings no Node of its own (the native install is one binary) and
# `/plugin install` checks none, so `check`, the SessionStart hook, is where a
# missing or old one gets said: a line for the person in every session, and,
# once per machine and per problem, a note for the model to offer to set Node
# up (AskUserQuestion). Headless runs (`claude -p`) get neither: nobody to ask.
#
# The threshold is hooks/status.ts's nodeOk (22.18+ on 22, 23.6+ on 23, any
# 24+); test/launcher.test.ts holds the two to the same answers.

v=$(node --version 2>/dev/null) || v=
major= minor= patch=
case $v in
  v[0-9]*.[0-9]*.[0-9]*)
    rest=${v#v}
    major=${rest%%.*}
    rest=${rest#*.}
    minor=${rest%%.*}
    patch=${rest#*.}
    patch=${patch%%[!0-9]*}
    case $major$minor in *[!0-9]*) major= ;; esac
    ;;
esac

ok=
if [ -n "$major" ]; then
  if [ "$major" -ge 24 ]; then ok=1
  elif [ "$major" -eq 23 ] && [ "$minor" -ge 6 ]; then ok=1
  elif [ "$major" -eq 22 ] && [ "$minor" -ge 18 ]; then ok=1
  fi
fi

if [ -n "$ok" ]; then
  [ "$1" = check ] && exit 0
  exec node --disable-warning=ExperimentalWarning "$(dirname "$0")/cache-keeper.ts" "$@"
fi

[ "$1" = check ] || exit 0

# What a hook says must never fail the session either.
case ${CACHE_KEEPER_DISABLED:-} in 1|true|TRUE|yes|on) exit 0 ;; esac

if [ -z "$v" ]; then found='found none'
elif [ -z "$major" ]; then found='and node --version printed no version'
else found="found v$major.$minor.$patch"
fi
problem="cache-keeper is off: it needs Node.js 22.18 or later on PATH, $found"
human="$problem. To fix it, ask Claude: set up Node 22.18 for cache-keeper."

home=${CACHE_KEEPER_HOME:-$HOME/.claude-cache-keeper}
asked="$home/node-asked"
note=
if [ "${CLAUDE_CODE_ENTRYPOINT:-}" != sdk-cli ] && [ "$(cat "$asked" 2>/dev/null)" != "$found" ]; then
  if mkdir -p "$home" 2>/dev/null && printf '%s\n' "$found" > "$asked" 2>/dev/null; then
    note="The Claude Code plugin cache-keeper is installed but cannot run: $problem. Do not interrupt the task the user came with: first handle their first request, then, at the end of that reply, ask once with AskUserQuestion whether to set up Node now (options: Set up Node now / Not now). If they agree: use the version or package manager already on this machine (nvm, fnm, volta, asdf, mise, Homebrew, winget, apt and the like), keep the other Node versions, make the node that Claude Code hooks find on PATH resolve to 22.18 or later (the manager's default, not just this shell), show node --version, and tell them to restart Claude Code. If they decline, do not raise it again. This note is given once per machine."
  fi
fi

if [ -n "$note" ]; then
  printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$human" "$note"
else
  printf '{"systemMessage":"%s"}\n' "$human"
fi
exit 0
