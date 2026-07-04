#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8765}"
LOG_FILE="${LOG_FILE:-warpish-terminal.log}"
PID_FILE=".server.pid"

if curl -fsS "http://${HOST}:${PORT}/healthz" >/dev/null 2>&1; then
  echo "Warpish Terminal is already running on http://${HOST}:${PORT}"
else
  echo "Starting Warpish Terminal on ${HOST}:${PORT}..."
  PORT="$PORT" HOST="$HOST" npm start >"$LOG_FILE" 2>&1 &
  echo "$!" > "$PID_FILE"

  for _ in {1..80}; do
    if curl -fsS "http://${HOST}:${PORT}/healthz" >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done
fi

if ! curl -fsS "http://${HOST}:${PORT}/healthz" >/dev/null 2>&1; then
  echo "Server did not become healthy. Last log lines:" >&2
  tail -80 "$LOG_FILE" >&2 || true
  exit 1
fi

TOKEN="$(tr -d '\n' < .auth-token)"
URL="http://${HOST}:${PORT}/?token=${TOKEN}"
open -a "Google Chrome" "$URL"
echo "Opened in Chrome: $URL"
echo "Log: $(pwd)/$LOG_FILE"
