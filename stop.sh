#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
PID_FILE=".server.pid"
PORT="${PORT:-8765}"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" >/dev/null 2>&1; then
  kill "$(cat "$PID_FILE")"
  rm -f "$PID_FILE"
  echo "Stopped Warpish Terminal from pid file."
  exit 0
fi

PIDS="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$PIDS" ]]; then
  echo "$PIDS" | xargs kill
  echo "Stopped listener(s) on port $PORT."
else
  echo "No Warpish Terminal listener found on port $PORT."
fi
