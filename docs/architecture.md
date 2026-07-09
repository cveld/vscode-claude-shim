# Architecture

## What runs where

- **code-server** (`codercom/code-server` base image) — VS Code in the browser, port 8080.
- **Anthropic.claude-code** VS Code extension, installed from **Open VSX** (code-server's
  default marketplace). Anthropic publishes there too, including a `linux-x64` build —
  confirmed via the Open VSX API (`https://open-vsx.org/api/anthropic/claude-code`) and the
  VS Code Marketplace gallery API, both listing `linux-x64`/`linux-arm64`/`alpine-*` alongside
  the desktop platforms.
- **`@anthropic-ai/claude-code` CLI**, installed globally via npm. The extension launches this
  as a subprocess; it is not a separate mechanism.
- **Host-side launcher daemon** (`daemon/`) — a plain Node.js process on the Windows host
  (not containerized) that starts/stops project-scoped `code-server` containers on demand,
  talking to Docker Desktop via `dockerode` over its Windows named pipe. It serves both its
  own REST API (`/api/*`) and a Next.js (TypeScript/React, Pages Router) launcher UI from the
  same process/port (`127.0.0.1:4590`) — the UI is embedded via Next's custom-server API
  (`next({dev, dir: 'launcher'})`, `getRequestHandler()`), not run as a separate always-on
  process. The Next app lives in `daemon/launcher/` as its own npm workspace package. See
  [plan-launcher-daemon.md](plan-launcher-daemon.md) for the full design (path-validation
  boundary, least-privilege bind mounts, `.claude` allow-listing).

This is not a protocol shim — it's the real extension running inside a real (browser-based)
VS Code. See [docs/re/ide-protocol.md](re/ide-protocol.md) for how the extension/CLI pair
detect and talk to each other, discovered by reading `extension.js` and the `claude` binary
directly.

## Image layering gotcha

The base image sets `HOME=/home/coder` even while `USER root` is active in a later `RUN`
step — Docker's `USER` directive changes the effective UID, not the `HOME` env var, which
was already baked in by an earlier `ENV` in the base image. Any root-context `RUN` that writes
to `$HOME` (e.g. npm postinstall scripts) therefore writes into `/home/coder/...` as root,
which the `coder` user can't later write to. See
[docs/troubleshooting.md](troubleshooting.md#claude-directory-not-writable) for the fix
and how to spot it.

## Verifying the extension UI actually renders

Manual browser testing works, but for a fast/repeatable check: Playwright (`chromium`,
headless) driving the real login form (`input.password` / `input.submit` on `/login`) and
the workbench (`.monaco-workbench`) is enough to confirm the extension activated — its chat
panel shows distinctive strings not present in generic VS Code: "Agent Sessions",
"Set Session Target - Local", "Permission picker, Default Approvals".

Driving the **integrated terminal** via Playwright is comparatively unreliable —
`page.keyboard.type()` into the xterm surface is prone to dropped/duplicated characters
(race with the terminal's own input handling), and a first `Ctrl+\`` in a fresh workspace
opens the "Do you trust the authors of this folder?" dialog instead of a terminal. If you need
terminal output for a check, redirect it to a file from within the container and read that
file via `docker exec` rather than scraping the xterm DOM.
