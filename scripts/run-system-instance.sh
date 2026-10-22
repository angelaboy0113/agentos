#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TASK_NODE_BIN=""
for candidate in "$(command -v node || true)" "$HOME"/.nvm/versions/node/v22*/bin/node /opt/homebrew/opt/node@22/bin/node /usr/local/opt/node@22/bin/node; do
  [ -x "$candidate" ] || continue
  if [ "$("$candidate" -p 'process.versions.node.split(".")[0]')" = 22 ]; then TASK_NODE_BIN=$candidate; break; fi
done
if [ -z "$TASK_NODE_BIN" ]; then echo '请先安装 Node 22'; exit 1; fi
exec "$TASK_NODE_BIN" "$SCRIPT_DIR/run-system-instance.mjs" "${1:---check}"
