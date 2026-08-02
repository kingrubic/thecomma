#!/bin/zsh
cd "$(dirname "$0")" || exit 1
PORT=8765
if ! curl -s "http://127.0.0.1:${PORT}" >/dev/null 2>&1; then
  python3 -m http.server "$PORT" --bind 127.0.0.1 &
  SERVER_PID=$!
  sleep 1
fi
open "http://127.0.0.1:${PORT}"
if [[ -n "$SERVER_PID" ]]; then
  wait "$SERVER_PID"
fi
