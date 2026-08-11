#!/usr/bin/env bash
# Reconciles the runtime volume with the image before handing off to code-server's real
# entrypoint: required user settings, then the pinned Claude extension version, then the side-bar
# session-resume patch. Order matters — auto-update must be off before installing, and a freshly
# installed bundle still needs patching. Every step is idempotent and best-effort: a failure must
# never stop the container from starting. See container-assets/sync-user-settings.mjs,
# container-assets/sync-claude-extension.sh and container-assets/patch-claude-sidebar.mjs.
set -u

node /usr/local/bin/sync-user-settings.mjs || echo "[entrypoint-wrapper] user-settings sync skipped"

/usr/local/bin/sync-claude-extension.sh || echo "[entrypoint-wrapper] extension sync skipped"

node /usr/local/bin/patch-claude-sidebar.mjs || echo "[entrypoint-wrapper] sidebar patch skipped"

# Session broker (opt-in, SHIM_SESSION_BROKER=1): owns the Claude CLI processes so a running turn
# survives the extension host being torn down and rebuilt. Started before code-server so the socket
# exists by the time the extension first launches the CLI. The restart loop covers a crashing
# broker; it cannot save a turn that was in flight, because the CLI's pipes terminate in the broker.
# See container-assets/claude-broker/ and docs/plan-session-broker.md.
if [ "${SHIM_SESSION_BROKER:-0}" = "1" ]; then
    (
        while true; do
            node /usr/local/bin/claude-broker.mjs
            echo "[entrypoint-wrapper] broker exited ($?); restarting in 2s"
            sleep 2
        done
    ) &
    echo "[entrypoint-wrapper] session broker started"
fi

exec /usr/bin/entrypoint.sh "$@"
