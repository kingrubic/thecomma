#!/bin/zsh
set -uo pipefail

export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
cd /Users/vsc_agent/projects/the-comma-coffee-website
export CONVEX_AGENT_MODE=anonymous

convex_pid=""
web_pid=""
stopping=0

stop_children() {
  if (( stopping )); then
    return
  fi
  stopping=1

  if [[ -n "$web_pid" ]] && kill -0 "$web_pid" 2>/dev/null; then
    kill -TERM "$web_pid" 2>/dev/null || true
  fi
  if [[ -n "$convex_pid" ]] && kill -0 "$convex_pid" 2>/dev/null; then
    kill -TERM "$convex_pid" 2>/dev/null || true
  fi

  [[ -n "$web_pid" ]] && wait "$web_pid" 2>/dev/null || true
  [[ -n "$convex_pid" ]] && wait "$convex_pid" 2>/dev/null || true
}

trap 'stop_children; exit 0' TERM INT
trap 'stop_children' EXIT

/Users/vsc_agent/projects/the-comma-coffee-website/node_modules/.bin/convex dev \
  --typecheck disable \
  --tail-logs disable \
  --local-cloud-port 3240 \
  --local-site-port 3241 &
convex_pid=$!

while kill -0 "$convex_pid" 2>/dev/null; do
  /opt/homebrew/bin/node server.mjs &
  web_pid=$!
  wait "$web_pid" 2>/dev/null || true
  web_pid=""

  if kill -0 "$convex_pid" 2>/dev/null; then
    print -u2 "THE COMMA web exited; restarting in 2 seconds"
    sleep 2
  fi
done

wait "$convex_pid" 2>/dev/null || true
exit 1
