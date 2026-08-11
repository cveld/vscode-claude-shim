# VSCode Claude Shim

Runs the real **Claude Code for VS Code** extension inside code-server (VS Code in the
browser), so the extension's own UI (chat panel, agent sessions, diff view) works headlessly —
no desktop VS Code involved. See [README.md](README.md) for usage.

## Language rule

All text written in markdown files and scripts (comments, UI strings, help text, error
messages) must be in **English**. This applies to new and edited content alike.

## Quick start

```sh
docker compose up -d --build
```
Open http://localhost:8080 (password from `PASSWORD` in `docker-compose.yml`).

## Key facts

- Extension installs from **Open VSX** — Anthropic publishes there too, `linux-x64` build
  included. The version is pinned by `CLAUDE_VERSION` in the `Dockerfile` (one arg for both the
  extension VSIX and the npm CLI). Bump it, rebuild, then Stop + Launch the instance;
  `container-assets/sync-claude-extension.sh` refreshes the per-project volume at boot, because
  Docker seeds a named volume only once and the version would otherwise stay frozen forever. See
  [docs/troubleshooting.md](docs/troubleshooting.md#claude-extension-stuck-on-an-old-version).
- `~/.claude` **must** stay writable by the `coder` user — see
  [docs/architecture.md](docs/architecture.md#image-layering-gotcha) for the `HOME` gotcha
  that broke this once already.
- `autoInstallIdeExtension` is disabled by default in the shipped `~/.claude/settings.json` —
  code-server has no `code` binary, so the CLI's own auto-install-companion-extension feature
  can't work here. See [docs/troubleshooting.md](docs/troubleshooting.md).

## Docs

- [Architecture](docs/architecture.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Launcher plan](docs/plan-launcher.md) — multi-project launcher with API and UI parts, decisions and build-order status
- [Session broker plan](docs/plan-session-broker.md) — keeping a running Claude turn alive across
  extension-host restarts, by launching the CLI through a broker daemon instead of as a child of the
  extension host

### RE docs (`docs/re/`)

See the [RE index](docs/re/README.md). Split by track:

- **Shared** — [How the extension and CLI detect each other (lock file, WebSocket, settings)](docs/re/ide-protocol.md) ·
  [Keeping the extension host alive when the browser window closes](docs/re/exthost-keepalive.md)
  (the container stays up by itself; the extension host does not, hence the build-time workbench patch) ·
  [Surviving an extension-host restart by owning the CLI process](docs/re/session-broker.md)
  (the `claudeCode.claudeProcessWrapper` seam; basis for [the broker plan](docs/plan-session-broker.md))
- **Mini-launcher** — [Opening a specific Claude session from the mini-launcher](docs/re/mini-launcher/session-open-bridge.md) (why there's no session deep-link in code-server; the `shim-session-opener` companion extension)
- **vscode-simulator** — [Claude extension UI packaging](docs/re/vscode-simulator/ui-packaging.md) (webview bundle/views; basis for the render-first mock shell)
