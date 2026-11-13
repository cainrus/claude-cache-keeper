#!/bin/sh
# Every hook command enters here. With a node on PATH that runs .ts natively it
# hands over to cache-keeper.ts (stdin and exit code pass through: `exec`);
# without one it does nothing and exits 0, so a session never shows a hook
# error and is never held up by keeper.
#
# Claude Code brings no Node of its own (the native install is one binary) and
# `/plugin install` checks none, so `check`, the SessionStart hook, is where a
# missing or old one gets said: a line for the person in every session, and,
# once per machine for each kind of problem (none, too old, no version), a
# note for the model to offer to set Node up (AskUserQuestion). Only on a fresh
# start, and never in an SDK or `claude -p` run: nobody there to ask.
#
# The threshold is hooks/status.ts's nodeOk (22.18+ on 22, 23.6+ on 23, any
# 24+); test/launcher.test.ts holds the two to the same answers.

v=$(node --version 2>/dev/null </dev/null) || v=
major= minor= patch=
case $v in
  v[0-9]*.[0-9]*.[0-9]*)
    rest=${v#v}
    major=${rest%%.*}
    rest=${rest#*.}
    minor=${rest%%.*}
    patch=${rest#*.}
    patch=${patch%%[!0-9]*}
    case $major in ''|*[!0-9]*) major= ;; esac
    case $minor in ''|*[!0-9]*) major= ;; esac
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

# Keeper turned off says nothing, as src/config.ts reads it: the env first
# (trimmed, any case; it also turns keeper back on over the file), else a
# top-level "enabled" of false, "false", "no", "off" or "0" in config.json.
# Arrays and nested objects (handoff's own "enabled") are cut out first.
lower() { printf '%s' "$1" | tr -d ' \t' | tr '[:upper:]' '[:lower:]'; }
home=$(lower "${CACHE_KEEPER_HOME:-}")
home=${home:+$CACHE_KEEPER_HOME}
home=${home:-$HOME/.claude-cache-keeper}
case $(lower "${CACHE_KEEPER_DISABLED:-}") in
  1|true|yes|on) exit 0 ;;
  0|false|no|off) ;;
  *)
    if [ -r "$home/config.json" ] &&
      tr -d '\n\r' < "$home/config.json" |
        sed -e ':a' -e 's/\[[^][]*\]/0/' -e 'ta' -e ':b' -e 's/\({[^{}]*\){[^{}]*}/\10/' -e 'tb' |
        grep -Eiq '"enabled"[[:space:]]*:[[:space:]]*(false|"(false|no|off|0)")'; then
      exit 0
    fi
    ;;
esac

if [ -z "$v" ]; then found='found none' kind=none
elif [ -z "$major" ]; then found='and node --version printed no version' kind=garbled
else found="found v$major.$minor.$patch" kind=old
fi
problem="cache-keeper is off: it needs Node.js 22.18 or later on PATH, $found"
human="$problem. To fix it, ask Claude: set up Node 22.18 for cache-keeper."

# SessionStart input names its source: startup, resume, clear or compact.
fresh=
cat | tr -d '\n\r' | grep -Eq '"source"[[:space:]]*:[[:space:]]*"startup"' && fresh=1
case ${CLAUDE_CODE_ENTRYPOINT:-} in sdk-*) fresh= ;; esac

asked="$home/node-asked"
note=
if [ -n "$fresh" ] && ! grep -qx "$kind" "$asked" 2>/dev/null; then
  if mkdir -p "$home" 2>/dev/null && printf '%s\n' "$kind" >> "$asked" 2>/dev/null; then
    note="The Claude Code plugin cache-keeper is installed but cannot run: $problem. Do not interrupt the task the user came with: first handle their first request, then, at the end of that reply, ask once with AskUserQuestion whether to set up Node now (options: Set up Node now / Not now). If they agree: use the version or package manager already on this machine (nvm, fnm, volta, asdf, mise, Homebrew, winget, apt and the like), keep the other Node versions, make the node that Claude Code hooks find on PATH resolve to 22.18 or later (the manager's default, not just this shell), show node --version, and tell them to restart Claude Code. If they decline, do not raise it again. This note is given once per machine."
  fi
fi

if [ -n "$note" ]; then
  printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$human" "$note"
else
  printf '{"systemMessage":"%s"}\n' "$human"
fi
exit 0
