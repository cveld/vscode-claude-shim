# Runs the real Claude Code VS Code extension inside code-server (VS Code in the browser),
# so you get the full extension UI (chat panel, diagnostics, diff view, etc.) headlessly.
FROM codercom/code-server:latest

# Single pinned Claude Code version, used for both the npm CLI and the VS Code extension —
# Anthropic releases them in lockstep, and the extension refuses to pair with a mismatched CLI.
# Bump this to update (then rebuild; running containers pick it up on their next start via
# container-assets/sync-claude-extension.sh). Latest versions:
#   extension — https://open-vsx.org/api/Anthropic/claude-code/linux-x64/latest
#   CLI       — npm view @anthropic-ai/claude-code version
ARG CLAUDE_VERSION=2.1.226

USER root

# Node.js is required by the claude-code CLI, which the extension launches as a subprocess.
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# HOME is inherited as /home/coder from the base image even while USER is root here;
# without overriding it, npm's postinstall would create /home/coder/.claude as root,
# leaving it unwritable for the coder user at runtime.
RUN HOME=/root npm install -g "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
    && rm -rf /home/coder/.claude

# The extension VSIX is fetched from Open VSX (code-server's default marketplace; Anthropic
# publishes there too, `linux-x64` build included) and kept at a path *outside* any runtime
# volume, so the boot-time sync can reinstall it offline. See sync-claude-extension.sh for why
# a build-time install alone is not enough.
RUN mkdir -p /usr/local/share/shim \
    && curl -fsSL -o /usr/local/share/shim/claude-code.vsix \
       "https://open-vsx.org/api/Anthropic/claude-code/linux-x64/${CLAUDE_VERSION}/file/Anthropic.claude-code-${CLAUDE_VERSION}@linux-x64.vsix" \
    && printf '%s\n' "${CLAUDE_VERSION}" > /usr/local/share/shim/claude-code.version \
    && chmod 0644 /usr/local/share/shim/claude-code.vsix /usr/local/share/shim/claude-code.version

USER coder

# Seeds the extensions dir so a *fresh* volume already carries the pinned version — installed
# from the baked-in VSIX rather than by marketplace id, so the build cannot drift off the pin.
RUN code-server --install-extension /usr/local/share/shim/claude-code.vsix --force

# The CLI's "auto-install IDE extension into VS Code via the `code` CLI" feature assumes
# a desktop VS Code/fork and errors out under code-server (no `code` binary on PATH).
# We already install the matching extension version above, so disable that feature.
RUN mkdir -p /home/coder/.claude \
    && echo '{"autoInstallIdeExtension": false}' > /home/coder/.claude/settings.json

# Static inbox-monitor script for the Claude Code Dashboard SessionStart hook (see
# launcher/shim-settings.json). Rarely changes, so it's baked into the image rather than
# regenerated per launch like launcher/shim-settings.json itself.
COPY --chmod=0755 container-assets/shim-inbox-monitor.sh /usr/local/bin/shim-inbox-monitor.sh

# Boot-time reconcile of the extension version inside the per-project runtime volume, which
# Docker seeds only once and therefore freezes at the version of the first launch.
COPY --chmod=0755 container-assets/sync-claude-extension.sh /usr/local/bin/sync-claude-extension.sh

# Companion extension that opens a specific Claude session when the mini-launcher signals one.
# It MUST live in the built-in extensions dir, not ~/.local/share/code-server/extensions — the
# latter is a runtime volume that would mask anything baked into the image. See
# container-assets/shim-session-opener/extension.js for how the launcher signals it.
COPY --chmod=0755 container-assets/shim-session-opener/ \
    /usr/lib/code-server/lib/vscode/extensions/shim-session-opener/

# Disable the "Do you trust the authors of this folder?" workspace trust dialog. It otherwise
# reappears on every fresh window/session even though the project folder never changes — see
# docs/troubleshooting.md#workspace-trust-dialog-reappears-every-session.
#
# Also disable extension auto-update. The side-bar resume patch (entrypoint-wrapper.sh) is
# applied to the extension bundle at container startup. If code-server silently auto-updates the
# Claude extension mid-run, the running extension host loads a *newer, unpatched* bundle and the
# patch is defeated until the next boot — this exact regression cost a debugging session (211 was
# patched, code-server had already updated to an unpatched 212). Pinning updates off keeps the
# loaded version equal to the one the boot-time patcher patched. Updates therefore go through
# CLAUDE_VERSION above, not through code-server's updater.
#
# This file lands in the runtime volume, so pre-existing volumes never received it — which is how
# one project ended up carrying two auto-updated extension versions. sync-user-settings.mjs
# re-applies these keys at every boot; this build-time write only seeds fresh volumes.
RUN mkdir -p /home/coder/.local/share/code-server/User \
    && echo '{"security.workspace.trust.enabled": false, "extensions.autoUpdate": false, "extensions.autoCheckUpdates": false}' > /home/coder/.local/share/code-server/User/settings.json

# Startup patch that lets a specific Claude session resume *in the side bar* (the shipped
# extension only exposes editor-panel resume). Runs each boot before code-server, idempotently,
# because the extension lives in a runtime volume — see container-assets/patch-claude-sidebar.mjs
# and docs/re/mini-launcher/session-open-bridge.md.
USER root
COPY --chmod=0644 container-assets/sync-user-settings.mjs /usr/local/bin/sync-user-settings.mjs
COPY --chmod=0644 container-assets/patch-claude-sidebar.mjs /usr/local/bin/patch-claude-sidebar.mjs
COPY --chmod=0755 container-assets/entrypoint-wrapper.sh /usr/local/bin/entrypoint-wrapper.sh

# Keeps the extension host — and with it a running Claude session — alive when the browser window
# closes; stock code-server tears it down within ~3s. Patched at *build* time, unlike the sidebar
# patch above: these files live in the image, not in a runtime volume, so nothing can mask or
# freeze the patch later. The script exits non-zero if an injection point moved, failing the build
# instead of silently shipping without the feature. See
# container-assets/patch-workbench-keepalive.mjs and docs/re/exthost-keepalive.md.
COPY --chmod=0644 container-assets/patch-workbench-keepalive.mjs /usr/local/bin/patch-workbench-keepalive.mjs
RUN node /usr/local/bin/patch-workbench-keepalive.mjs

# Session broker: launches the Claude CLI from a long-lived daemon instead of as a child of the
# extension host, so a running turn is not destroyed when the browser tab is closed and reopened.
# Opt-in per instance with SHIM_SESSION_BROKER=1 — entrypoint-wrapper.sh starts the daemon and
# sync-user-settings.mjs points `claudeCode.claudeProcessWrapper` at the wrapper. Off by default: a
# broken broker would break all Claude usage in the container, and configuring the wrapper also
# shifts permission-mode resolution to the extension. See docs/plan-session-broker.md and
# docs/re/session-broker.md.
COPY --chmod=0644 container-assets/claude-broker/broker.mjs /usr/local/bin/claude-broker.mjs
COPY --chmod=0644 container-assets/claude-broker/client.mjs /usr/local/bin/claude-broker-client.mjs
COPY --chmod=0755 container-assets/claude-broker/wrapper.sh /usr/local/bin/claude-wrapper.sh
COPY --chmod=0644 container-assets/claude-broker/_probe-survival.mjs /usr/local/bin/claude-broker-probe.mjs

USER coder

WORKDIR /home/coder/project

ENTRYPOINT ["/usr/local/bin/entrypoint-wrapper.sh"]
CMD ["--bind-addr", "0.0.0.0:8080", "/home/coder/project"]
