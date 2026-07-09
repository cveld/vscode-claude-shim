#!/usr/bin/env bash
# Session inbox monitor, run inside the vscode-claude-shim container via the Monitor tool.
# Invoked by the SessionStart hook in daemon/shim-settings.json, which passes the current
# Claude Code session id as $1. Mirrors the host's Claude Code Dashboard inbox monitor
# (https://github.com/uppinote20's session-start-hook.ps1 pattern), swapping python3 for
# node since the image has no Python.
SESSION_ID="$1"
if [ -z "$SESSION_ID" ]; then exit 1; fi

FILE="$HOME/.claude/sessions/${SESSION_ID}-inbox.jsonl"
READY="$HOME/.claude/sessions/${SESSION_ID}-monitor.ready"

mkdir -p "$HOME/.claude/sessions"
touch "$FILE" "$READY"
trap 'rm -f "$READY"' EXIT
(while [ -f "$READY" ]; do touch "$READY"; sleep 20; done) &
HB=$!

tail -f -n 0 "$FILE" | while IFS= read -r line; do
  [ -f "$READY" ] || break
  node -e "
try {
  const d = JSON.parse(process.argv[1]);
  if (d.message) console.log('MSG: ' + d.message);
  else console.log('RAW: ' + process.argv[1]);
} catch (e) {
  console.log('ERR: ' + e.message + ' | ' + process.argv[1]);
}
" "$line"
done
kill "$HB" 2>/dev/null
