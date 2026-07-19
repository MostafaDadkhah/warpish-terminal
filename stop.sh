#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
PROJECT_ROOT="$(pwd -P)"
PID_FILE=".server.pid"
PORT="${PORT:-8765}"
LAUNCH_AGENT_LABEL="${WARPISH_LAUNCH_AGENT_LABEL:-com.warpish.terminal}"
LAUNCH_AGENT_TARGET="gui/$(id -u)/${LAUNCH_AGENT_LABEL}"

if [[ "$PORT" == "8765" ]] && launchctl print "$LAUNCH_AGENT_TARGET" >/dev/null 2>&1; then
  launchctl bootout "$LAUNCH_AGENT_TARGET"
  rm -f "$PID_FILE"
  echo "Stopped Warpish Terminal LaunchAgent for this login session."
  echo "Run ./start.sh to start it again; it will also start automatically at the next login."
  exit 0
fi

pid_cwd() {
  local pid="$1"
  lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1 || true
}

is_warpish_pid() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" >/dev/null 2>&1 || return 1
  local command cwd
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  cwd="$(pid_cwd "$pid")"
  [[ "$command" == *"node"* && "$command" == *"server.js"* && "$cwd" == "$PROJECT_ROOT" ]]
}

stop_pid() {
  local pid="$1"
  kill "$pid"
  echo "Stopped Warpish Terminal pid $pid."
}

if [[ -f "$PID_FILE" ]]; then
  PID="$(tr -d '[:space:]' < "$PID_FILE")"
  if is_warpish_pid "$PID"; then
    stop_pid "$PID"
    rm -f "$PID_FILE"
    exit 0
  fi
  echo "Ignoring stale/unsafe pid file entry: $PID" >&2
  rm -f "$PID_FILE"
fi

PIDS="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
for PID in $PIDS; do
  if is_warpish_pid "$PID"; then
    stop_pid "$PID"
    exit 0
  fi
done

if [[ -n "$PIDS" ]]; then
  echo "Listener(s) exist on port $PORT, but none matched Warpish Terminal in $PROJECT_ROOT; not killing arbitrary processes." >&2
  echo "Set WARPISH_STOP_BY_PORT=1 only if you have manually verified the listener is safe to stop." >&2
  if [[ "${WARPISH_STOP_BY_PORT:-}" == "1" ]]; then
    echo "$PIDS" | xargs kill
    echo "Stopped listener(s) on port $PORT by explicit override."
    exit 0
  fi
  exit 1
fi

echo "No Warpish Terminal listener found on port $PORT."
