#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
umask 077
PROJECT_ROOT="$(pwd -P)"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8765}"
LOG_FILE="${LOG_FILE:-warpish-terminal.log}"
PID_FILE=".server.pid"
TOKEN_FILE="${WARPISH_TOKEN_FILE:-.auth-token}"
HEALTH_URL="http://${HOST}:${PORT}/healthz"

if [[ -e "$LOG_FILE" ]]; then
  chmod 600 "$LOG_FILE"
fi

is_warpish_health() {
  local body
  body="$(curl --connect-timeout 1 --max-time 2 -fsS "$HEALTH_URL" 2>/dev/null || true)"
  [[ "$body" == *'"app":"warpish-terminal"'* ]]
}

pid_cwd() {
  local pid="$1"
  lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1 || true
}

warpish_listener_pid() {
  local pid command cwd
  for pid in $(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true); do
    command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    cwd="$(pid_cwd "$pid")"
    if [[ "$command" == *"node"* && "$command" == *"server.js"* && "$cwd" == "$PROJECT_ROOT" ]]; then
      echo "$pid"
      return 0
    fi
  done
  return 1
}

is_warpish_instance() {
  is_warpish_health && warpish_listener_pid >/dev/null
}

if is_warpish_instance; then
  echo "Warpish Terminal is already running on http://${HOST}:${PORT}"
else
  echo "Starting Warpish Terminal on ${HOST}:${PORT}..."
  touch "$LOG_FILE"
  chmod 600 "$LOG_FILE"
  PORT="$PORT" HOST="$HOST" WARPISH_REDACT_LOG_TOKEN=1 npm start >"$LOG_FILE" 2>&1 &
  echo "$!" > "$PID_FILE"

  for _ in {1..80}; do
    if is_warpish_instance; then
      break
    fi
    sleep 0.1
  done
fi

if ! is_warpish_instance; then
  echo "Server did not become healthy or health endpoint did not identify Warpish Terminal. Last log lines:" >&2
  tail -80 "$LOG_FILE" >&2 || true
  exit 1
fi

LISTENER_PID="$(warpish_listener_pid)"
echo "$LISTENER_PID" > "$PID_FILE"

if [[ -n "${WARPISH_TOKEN:-}" ]]; then
  TOKEN="$WARPISH_TOKEN"
elif [[ -r "$TOKEN_FILE" ]]; then
  TOKEN="$(tr -d '\n' < "$TOKEN_FILE")"
else
  echo "Server is running, but no readable token file was found at $TOKEN_FILE." >&2
  echo "Check $LOG_FILE for the bootstrap URL." >&2
  exit 1
fi

READY_BODY="$(curl --connect-timeout 1 --max-time 5 -fsS -H "x-warpish-token: $TOKEN" "http://${HOST}:${PORT}/readyz" 2>/dev/null || true)"
if [[ "$READY_BODY" != *'"app":"warpish-terminal"'* || "$READY_BODY" != *'"ok":true'* ]]; then
  echo "Server is listening, but Warpish Terminal is not ready. Last log lines:" >&2
  tail -80 "$LOG_FILE" >&2 || true
  exit 1
fi

URL="http://${HOST}:${PORT}/?token=${TOKEN}"
open -a "Google Chrome" "$URL"
echo "Opened in Chrome: http://${HOST}:${PORT}/?token=<redacted>"
echo "Log: $(pwd)/$LOG_FILE"
