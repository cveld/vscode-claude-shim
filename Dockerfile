# Runs the real Claude Code VS Code extension inside code-server (VS Code in the browser),
# so you get the full extension UI (chat panel, diagnostics, diff view, etc.) headlessly.
FROM codercom/code-server:latest

USER root

# Node.js is required by the claude-code CLI, which the extension launches as a subprocess.
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# HOME is inherited as /home/coder from the base image even while USER is root here;
# without overriding it, npm's postinstall would create /home/coder/.claude as root,
# leaving it unwritable for the coder user at runtime.
RUN HOME=/root npm install -g @anthropic-ai/claude-code \
    && rm -rf /home/coder/.claude

USER coder

# Installs from Open VSX (code-server's default marketplace); Anthropic publishes there too.
RUN code-server --install-extension Anthropic.claude-code

# The CLI's "auto-install IDE extension into VS Code via the `code` CLI" feature assumes
# a desktop VS Code/fork and errors out under code-server (no `code` binary on PATH).
# We already install the matching extension version above, so disable that feature.
RUN mkdir -p /home/coder/.claude \
    && echo '{"autoInstallIdeExtension": false}' > /home/coder/.claude/settings.json

# Static inbox-monitor script for the Claude Code Dashboard SessionStart hook (see
# daemon/shim-settings.json). Rarely changes, so it's baked into the image rather than
# regenerated per launch like daemon/shim-settings.json itself.
COPY --chmod=0755 container-assets/shim-inbox-monitor.sh /usr/local/bin/shim-inbox-monitor.sh

# Disable the "Do you trust the authors of this folder?" workspace trust dialog. It otherwise
# reappears on every fresh window/session even though the project folder never changes — see
# docs/troubleshooting.md#workspace-trust-dialog-reappears-every-session.
RUN mkdir -p /home/coder/.local/share/code-server/User \
    && echo '{"security.workspace.trust.enabled": false}' > /home/coder/.local/share/code-server/User/settings.json

WORKDIR /home/coder/project

ENTRYPOINT ["/usr/bin/entrypoint.sh"]
CMD ["--bind-addr", "0.0.0.0:8080", "/home/coder/project"]
