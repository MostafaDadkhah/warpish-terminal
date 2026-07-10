#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8765}"
LOG_FILE="${LOG_FILE:-warpish-terminal.log}"
PID_FILE=".server.pid"
TOKEN_FILE="${WARPISH_TOKEN_FILE:-.auth-token}"
HEALTH_URL="http://${HOST}:${PORT}/healthz"

is_warpish_health() {
  local body
  body="$(curl -fsS "$HEALTH_URL" 2>/dev/null || true)"
  [[ "$body" == *'"app":"warpish-terminal"'* ]]
}

if is_warpish_health; then
  echo "Warpish Terminal is already running on http://${HOST}:${PORT}"
else
  echo "Starting Warpish Terminal on ${HOST}:${PORT}..."
  PORT="$PORT" HOST="$HOST" npm start >"$LOG_FILE" 2>&1 &
  echo "$!" > "$PID_FILE"

  for _ in {1..80}; do
    if is_warpish_health; then
      break
    fi
    sleep 0.1
  done
fi

if ! is_warpish_health; then
  echo "Server did not become healthy or health endpoint did not identify Warpish Terminal. Last log lines:" >&2
  tail -80 "$LOG_FILE" >&2 || true
  exit 1
fi

if [[ -n "${WARPISH_TOKEN:-}" ]]; then
  TOKEN="$WARPISH_TOKEN"
elif [[ -r "$TOKEN_FILE" ]]; then
  TOKEN="$(tr -d '\n' < "$TOKEN_FILE")"
else
  echo "Server is running, but no readable token file was found at $TOKEN_FILE." >&2
  echo "Check $LOG_FILE for the bootstrap URL." >&2
  exit 1
fi

URL="http://${HOST}:${PORT}/?token=${TOKEN}"
open -a "Google Chrome" "$URL"
echo "Opened in Chrome: http://${HOST}:${PORT}/?token=<redacted>"
echo "Log: $(pwd)/$LOG_FILE"
