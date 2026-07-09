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

- Extension installs from **Open VSX** (`code-server --install-extension
  Anthropic.claude-code`) — Anthropic publishes there too, `linux-x64` build included.
- `~/.claude` **must** stay writable by the `coder` user — see
  [docs/architecture.md](docs/architecture.md#image-layering-gotcha) for the `HOME` gotcha
  that broke this once already.
- `autoInstallIdeExtension` is disabled by default in the shipped `~/.claude/settings.json` —
  code-server has no `code` binary, so the CLI's own auto-install-companion-extension feature
  can't work here. See [docs/troubleshooting.md](docs/troubleshooting.md).

## Docs

- [Architecture](docs/architecture.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Launcher daemon plan](docs/plan-launcher-daemon.md) — multi-project daemon + Next.js launcher UI, decisions and build-order status

### RE docs (`docs/re/`)

- [How the extension and CLI detect each other (lock file, WebSocket, settings)](docs/re/ide-protocol.md)
