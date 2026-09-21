#!/bin/bash
set -euo pipefail

LABEL="com.agentos.local"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
USER_ID="$(id -u)"

launchctl bootout "gui/$USER_ID/$LABEL" 2>/dev/null || true
rm -f "$PLIST_PATH"
echo "Removed current-user LaunchAgent: $LABEL"
