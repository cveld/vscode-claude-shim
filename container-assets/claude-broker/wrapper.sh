#!/bin/sh
# What `claudeCode.claudeProcessWrapper` points at. The extension calls this instead of the Claude
# CLI, as `wrapper.sh <executable> <cli args...>` — see docs/re/session-broker.md for the measured
# argv shape.
#
# Only stream-json queries carry a running turn and need brokering. The extension also makes short
# side calls through this same wrapper (`auth status --json` at startup, for one), and those must
# stay cheap: they are exec'd straight through, paying no Node startup cost. Node cannot exec, which
# is why this dispatcher is a shell script rather than part of client.mjs.
set -u

# Opt-in for now: a broken broker would break all Claude usage in the container, and setting the
# wrapper at all changes permission-mode handling. See docs/plan-session-broker.md.
#
# A live socket counts as consent too, so the wrapper works even where the env var did not reach the
# extension host. That is safe in both directions: sync-user-settings.mjs only points the extension
# at this wrapper when the flag is set, and client.mjs falls back to a direct spawn if it cannot
# reach the broker anyway.
if [ "${SHIM_SESSION_BROKER:-0}" != "1" ] && [ ! -S "${SHIM_BROKER_SOCK:-/tmp/claude-broker.sock}" ]; then
    exec "$@"
fi

for arg in "$@"; do
    if [ "$arg" = "--input-format" ]; then
        exec node /usr/local/bin/claude-broker-client.mjs "$@"
    fi
done

exec "$@"
