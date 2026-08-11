# Reverse-engineering notes

Findings from reading the installed Claude Code extension (`extension.js`), the `claude` CLI
binary, and code-server internals. Split by research track:

## Shared

- [ide-protocol.md](ide-protocol.md) — how the extension and CLI detect and talk to each other
  (the `~/.claude/ide` lock file, the local WebSocket/MCP server, the relevant settings). Both
  tracks below depend on this.
- [exthost-keepalive.md](exthost-keepalive.md) — closing the browser tab leaves the container up but
  kills the extension host (and the running Claude session) within ~3s; the build-time workbench
  patch that keeps it alive, and why a reopened tab can never re-attach to it.
- [session-broker.md](session-broker.md) — why a "proxy extension" can't work, and the seam that
  can: the extension's own `claudeCode.claudeProcessWrapper` setting, the exact argv it hands over,
  and what that implies for moving the CLI process out of the extension host's family tree.

## Mini-launcher (`mini-launcher/`)

The host-side launcher for one pinned folder that starts code-server containers and opens Claude
sessions.

- [mini-launcher/session-open-bridge.md](mini-launcher/session-open-bridge.md) — why there is no
  URL/deep-link into a specific Claude session in code-server, and the baked-in
  `shim-session-opener` companion extension that resumes the clicked session in the panel.

## vscode-simulator (`vscode-simulator/`)

The render-first "mock shell" experiment that tries to host the extension's own webview bundle
outside a full VS Code workbench.

- [vscode-simulator/ui-packaging.md](vscode-simulator/ui-packaging.md) — the extension UI is
  hybrid and strongly webview-based; the shipped `webview/` bundle and views that make a
  render-first mock shell plausible, plus the inspection harness.
