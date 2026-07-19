#!/usr/bin/env bash
set -euo pipefail

LABEL="${WARPISH_LAUNCH_AGENT_LABEL:-com.warpish.terminal}"
TARGET="gui/$(id -u)/${LABEL}"
PLIST_FILE="${HOME}/Library/LaunchAgents/${LABEL}.plist"

if launchctl print "$TARGET" >/dev/null 2>&1; then
  launchctl bootout "$TARGET"
fi

if [[ -f "$PLIST_FILE" ]]; then
  rm "$PLIST_FILE"
  echo "Removed ${PLIST_FILE}."
else
  echo "LaunchAgent plist was not installed."
fi

echo "Warpish Terminal will no longer start automatically."
