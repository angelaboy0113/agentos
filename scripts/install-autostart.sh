#!/bin/bash
set -euo pipefail

LABEL="com.agentos.local"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_BIN="$(command -v node)"
CODEX_BIN="$(command -v codex || true)"
NODE_DIR="$(dirname "$NODE_BIN")"
CODEX_DIR="$(dirname "${CODEX_BIN:-/usr/bin/codex}")"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$PROJECT_DIR/data/logs"
USER_ID="$(id -u)"

case "$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')" in
  22) ;;
  *) echo "AgentOS requires Node 22. Current node: $NODE_BIN ($("$NODE_BIN" -v))" >&2; exit 1 ;;
esac

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

mkdir -p "$PLIST_DIR" "$LOG_DIR"
PROJECT_XML="$(xml_escape "$PROJECT_DIR")"
NODE_XML="$(xml_escape "$NODE_BIN")"
PATH_XML="$(xml_escape "$NODE_DIR:$CODEX_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")"
HOME_XML="$(xml_escape "$HOME")"

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_XML</string>
    <string>$PROJECT_XML/src/control-plane/local.js</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT_XML</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME_XML</string>
    <key>PATH</key><string>$PATH_XML</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$PROJECT_XML/data/logs/agentos-launchd.log</string>
  <key>StandardErrorPath</key><string>$PROJECT_XML/data/logs/agentos-launchd-error.log</string>
</dict>
</plist>
PLIST

plutil -lint "$PLIST_PATH"
launchctl bootout "gui/$USER_ID/$LABEL" 2>/dev/null || true
for _ in $(seq 1 50); do
  if ! launchctl print "gui/$USER_ID/$LABEL" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
if launchctl print "gui/$USER_ID/$LABEL" >/dev/null 2>&1; then
  echo "Timed out waiting for the previous $LABEL process to stop" >&2
  exit 1
fi
launchctl bootstrap "gui/$USER_ID" "$PLIST_PATH"
launchctl enable "gui/$USER_ID/$LABEL"
launchctl kickstart -k "gui/$USER_ID/$LABEL"
echo "Installed and started $LABEL"
echo "Health: curl http://127.0.0.1:8787/health"
echo "Logs: $LOG_DIR/agentos-launchd.log"
