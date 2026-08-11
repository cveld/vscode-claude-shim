#!/usr/bin/env bash
# Reconciles the Claude Code extension inside the runtime volume with the version pinned in the
# image (CLAUDE_VERSION in the Dockerfile).
#
# Why this exists: the extension lives in /home/coder/.local/share/code-server/extensions, and
# that whole tree is a per-project Docker named volume. Docker seeds a named volume from the
# image *only the first time the volume is used*, so once a project has been launched, the
# extension version is frozen — rebuilding the image does not refresh it. Auto-update is also
# deliberately off (see the Dockerfile), because the side-bar patch rewrites the shipped bundle
# and an auto-update would load a newer, unpatched one. Without this script the extension could
# never be updated at all.
#
# Runs at container startup, before patch-claude-sidebar.mjs, and installs from the VSIX baked
# into the image — so no network access is needed at boot. Best-effort: never abort startup.
set -u

VERSION_FILE="/usr/local/share/shim/claude-code.version"
VSIX_PATH="/usr/local/share/shim/claude-code.vsix"
EXT_DIR="${SHIM_EXTENSIONS_DIR:-$HOME/.local/share/code-server/extensions}"

log() { echo "[sync-claude-extension] $*"; }

# Installed Claude extension directory names, space-separated ("<none>" when there are none).
installed_dirs() {
  local found
  found="$(find "$EXT_DIR" -maxdepth 1 -mindepth 1 -type d -name 'anthropic.claude-code-*' \
    -printf '%f ' 2>/dev/null)"
  echo "${found:-<none>}"
}

[[ -f "$VERSION_FILE" ]] || exit 0
PINNED="$(tr -d '[:space:]' < "$VERSION_FILE" 2>/dev/null)"
[[ -n "$PINNED" ]] || exit 0

# A platform-specific install may or may not carry a "-linux-x64" suffix on the directory name,
# depending on whether it came from the gallery or from a local VSIX — accept both.
if compgen -G "${EXT_DIR}/anthropic.claude-code-${PINNED}" > /dev/null \
  || compgen -G "${EXT_DIR}/anthropic.claude-code-${PINNED}-*" > /dev/null; then
  log "up to date (${PINNED})"
  exit 0
fi

if [[ ! -f "$VSIX_PATH" ]]; then
  log "pinned VSIX missing at ${VSIX_PATH}; leaving $(installed_dirs) in place"
  exit 0
fi

before="$(installed_dirs)"
log "installing pinned ${PINNED} over ${before}"

install_log="$(mktemp)"
if code-server --extensions-dir "$EXT_DIR" --install-extension "$VSIX_PATH" --force \
  > "$install_log" 2>&1; then
  # The installer rewrites extensions.json to point at the new version but leaves the old
  # directory behind. Dead weight, and patch-claude-sidebar.mjs would keep patching it — so
  # drop every dir that is not the pinned one, now that extensions.json no longer references it.
  find "$EXT_DIR" -maxdepth 1 -mindepth 1 -type d -name 'anthropic.claude-code-*' \
    ! -name "anthropic.claude-code-${PINNED}" ! -name "anthropic.claude-code-${PINNED}-*" \
    -exec rm -rf {} + 2>/dev/null
  log "installed; extensions dir now holds $(installed_dirs)"
else
  log "install failed (non-fatal); extensions dir still holds $(installed_dirs)"
  sed 's/^/[sync-claude-extension]   /' "$install_log" 2>/dev/null
fi
rm -f "$install_log"

exit 0
