# VSCode Claude Shim

Runs the real **Claude Code for VS Code** extension inside [code-server](https://github.com/coder/code-server)
(VS Code in the browser), so you get the actual extension UI — chat panel, agent sessions, diff view,
diagnostics — on a headless host, with no desktop VS Code involved.

This is not a fake/shim of the IDE protocol: it's the genuine extension, genuinely running inside a
genuine (browser-based) VS Code. The extension therefore behaves exactly as it does on a normal desktop
install, including IDE-aware features that only work when Claude Code detects it's running inside VS Code.

## How it works

- Base image: `codercom/code-server`.
- Node.js 20 is installed (required by the `claude` CLI, which the extension launches as a subprocess).
- The `@anthropic-ai/claude-code` CLI is installed globally via npm.
- The `Anthropic.claude-code` VS Code extension is installed from Open VSX (code-server's default
  marketplace) — Anthropic publishes the extension there as well as on the VS Code Marketplace, including
  a `linux-x64` build.

## Usage

```sh
docker compose up -d --build
```

Open http://localhost:8080 and log in with the password set in `docker-compose.yml` (`PASSWORD`,
default `changeme` — **change this** before exposing the container beyond localhost).

The project folder is bind-mounted from `./project`. Claude Code settings/credentials
(`~/.claude`) and the code-server profile persist in named Docker volumes across restarts.

### Authenticating Claude Code

Open a terminal in code-server and run `claude` (or use the chat panel directly) to trigger the
OAuth login flow. Since there's no browser reachable from inside the container, `claude login` prints a
URL — open it on your own machine and paste back the resulting code.

Alternatively, skip the interactive login by setting one of these in `docker-compose.yml`:

- `ANTHROPIC_API_KEY` — pay-as-you-go API key.
- `CLAUDE_CODE_OAUTH_TOKEN` — a long-lived token from `claude setup-token` run elsewhere.

## Files

- `Dockerfile` — builds the image.
- `docker-compose.yml` — runs it with persistent volumes and port 8080 exposed.
