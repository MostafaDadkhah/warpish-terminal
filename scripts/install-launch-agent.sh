#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
LABEL="${WARPISH_LAUNCH_AGENT_LABEL:-com.warpish.terminal}"
DOMAIN="gui/$(id -u)"
TARGET="${DOMAIN}/${LABEL}"
PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST_FILE="${PLIST_DIR}/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs/Warpish Terminal"
NODE_BIN="${WARPISH_NODE_BIN:-$(command -v node || true)}"
HEALTH_URL="http://127.0.0.1:8765/healthz"
READY_URL="http://127.0.0.1:8765/readyz"
TOKEN_FILE="${PROJECT_ROOT}/.auth-token"

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "Node.js was not found. Install Node.js 20.12+ or set WARPISH_NODE_BIN." >&2
  exit 1
fi

NODE_MAJOR="$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])')"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ || "$NODE_MAJOR" -lt 20 ]]; then
  echo "Warpish Terminal requires Node.js 20.12+; found $("$NODE_BIN" --version)." >&2
  exit 1
fi

if [[ ! -d "${PROJECT_ROOT}/node_modules" ]]; then
  echo "Dependencies are missing. Run npm install before installing the LaunchAgent." >&2
  exit 1
fi

mkdir -p "$PLIST_DIR" "$LOG_DIR"
chmod 700 "$LOG_DIR"

TEMP_PLIST="$(mktemp "${PLIST_DIR}/.${LABEL}.XXXXXX")"
cleanup() {
  rm -f "$TEMP_PLIST"
}
trap cleanup EXIT

SERVICE_PATH="$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

/usr/bin/python3 - "$TEMP_PLIST" "$LABEL" "$NODE_BIN" "$PROJECT_ROOT" "$LOG_DIR" "$SERVICE_PATH" <<'PY'
import plistlib
import sys

plist_file, label, node_bin, project_root, log_dir, service_path = sys.argv[1:]
payload = {
    "Label": label,
    "ProgramArguments": [node_bin, f"{project_root}/server.js"],
    "WorkingDirectory": project_root,
    "RunAtLoad": True,
    "KeepAlive": True,
    "ProcessType": "Background",
    "ThrottleInterval": 5,
    "EnvironmentVariables": {
        "HOST": "127.0.0.1",
        "PORT": "8765",
        "PATH": service_path,
        "WARPISH_REDACT_LOG_TOKEN": "1",
    },
    "StandardOutPath": f"{log_dir}/warpish-terminal.log",
    "StandardErrorPath": f"{log_dir}/warpish-terminal.error.log",
}
with open(plist_file, "wb") as handle:
    plistlib.dump(payload, handle, sort_keys=False)
PY

chmod 600 "$TEMP_PLIST"
plutil -lint "$TEMP_PLIST" >/dev/null

if launchctl print "$TARGET" >/dev/null 2>&1; then
  launchctl bootout "$TARGET"
fi

"${PROJECT_ROOT}/stop.sh"
install -m 600 "$TEMP_PLIST" "$PLIST_FILE"
launchctl enable "$TARGET"
launchctl bootstrap "$DOMAIN" "$PLIST_FILE"
launchctl kickstart -k "$TARGET"

for _ in {1..120}; do
  HEALTH_BODY="$(curl --connect-timeout 1 --max-time 2 -fsS "$HEALTH_URL" 2>/dev/null || true)"
  if [[ "$HEALTH_BODY" == *'"app":"warpish-terminal"'* ]]; then
    break
  fi
  sleep 0.1
done

if [[ "${HEALTH_BODY:-}" != *'"app":"warpish-terminal"'* ]]; then
  echo "LaunchAgent was installed, but Warpish Terminal did not become healthy." >&2
  tail -60 "${LOG_DIR}/warpish-terminal.log" >&2 || true
  tail -60 "${LOG_DIR}/warpish-terminal.error.log" >&2 || true
  exit 1
fi

if [[ ! -r "$TOKEN_FILE" ]]; then
  echo "Warpish Terminal is healthy, but its token file is not readable." >&2
  exit 1
fi

TOKEN="$(tr -d '\n' < "$TOKEN_FILE")"
READY_BODY="$(curl --connect-timeout 1 --max-time 5 -fsS -H "x-warpish-token: $TOKEN" "$READY_URL" 2>/dev/null || true)"
if [[ "$READY_BODY" != *'"app":"warpish-terminal"'* || "$READY_BODY" != *'"ok":true'* ]]; then
  echo "Warpish Terminal is running but did not pass authenticated readiness." >&2
  exit 1
fi

echo "Installed and started ${LABEL}."
echo "Warpish Terminal will start at login and restart automatically after an unexpected exit."
echo "URL: http://127.0.0.1:8765"
echo "Logs: ${LOG_DIR}"
