# Architecture

## What runs where

- **code-server** (`codercom/code-server` base image) — VS Code in the browser, port 8080.
- **Anthropic.claude-code** VS Code extension, installed from **Open VSX** (code-server's
  default marketplace). Anthropic publishes there too, including a `linux-x64` build —
  confirmed via the Open VSX API (`https://open-vsx.org/api/anthropic/claude-code`) and the
  VS Code Marketplace gallery API, both listing `linux-x64`/`linux-arm64`/`alpine-*` alongside
  the desktop platforms. The version is pinned by the `CLAUDE_VERSION` build arg and its VSIX
  baked into the image, because the extensions directory is a per-project volume Docker seeds
  only once — see [Extension versioning](#extension-versioning).
- **`@anthropic-ai/claude-code` CLI**, installed globally via npm, pinned to the same
  `CLAUDE_VERSION` (Anthropic releases CLI and extension in lockstep). The extension launches this
  as a subprocess; it is not a separate mechanism.
- **Host-side launcher** (`launcher/`) — a plain Node.js process on the Windows host
  (not containerized) that starts/stops project-scoped `code-server` containers on demand,
  talking to Docker Desktop via `dockerode` over its Windows named pipe. It serves both the
  launcher API (`/api/*`) and the Next.js (TypeScript/React, Pages Router) launcher UI from the
  same process/port (`127.0.0.1:4590`) — the UI is embedded via Next's custom-server API, not
  run as a separate always-on process. The Next app lives in `launcher/ui/` as its own npm
  workspace package. See [plan-launcher.md](plan-launcher.md) for the full design
  (path-validation boundary, least-privilege bind mounts, `.claude` allow-listing).
- **Mini launcher** (`mini-launcher/`) — a separate Next.js (TypeScript/React, Pages Router)
  app on `127.0.0.1:4591` for one pinned folder only. Unlike the main launcher, it has no root
  browser or recent-list flow and no runtime dependency on `launcher/` being up: its own API
  routes (`pages/api/instance.ts`, `pages/api/launch.ts`, `pages/api/stop.ts`) talk directly to
  Docker via `mini-launcher/lib/docker.ts`. It reuses the main launcher's shared validation and
  mount-building code by importing `launcher/lib/paths.ts` and `launcher/lib/claudeHome.ts`, so
  container naming, volume reuse, and `.claude` allow-list mounts stay aligned across both UIs.
  Current scope is plain-folder pinned targets only — `.code-workspace` launch is intentionally
  not supported here. See [mini-launcher/README.md](../mini-launcher/README.md) for how to run it
  and how the per-session "Editor" / "Side bar" open features work.
+- **Shared Claude host directories across launcher-managed containers** — both the main launcher
  and the mini-launcher now bind-mount selected host `~/.claude` subdirectories into each
  container: `commands/`, `skills/`, `sessions/`, `projects/`, and `ide/`, plus the generated
  `settings.json`. This makes three cross-boundary behaviors possible without extra services:
  transcript discovery from the host (`projects/`), per-session inbox messaging (`sessions/`),
  and host visibility into the extension's IDE lock-file protocol (`ide/`). The `.claude`
  volume is still per-instance for everything else.

This is not a protocol shim — it's the real extension running inside a real (browser-based)
VS Code. See [docs/re/ide-protocol.md](re/ide-protocol.md) for how the extension/CLI pair
detect and talk to each other, discovered by reading `extension.js` and the `claude` binary
directly.

## Reverse-engineering notes

RE findings live under [docs/re/](re/README.md), split by track: shared extension/CLI detection
([ide-protocol.md](re/ide-protocol.md)), **mini-launcher** research (e.g. how a clicked session
is opened in the panel — [session-open-bridge.md](re/mini-launcher/session-open-bridge.md)), and
**vscode-simulator** research (the extension's webview UI packaging and the render-first mock
shell — [ui-packaging.md](re/vscode-simulator/ui-packaging.md)).

## Image layering gotcha

The base image sets `HOME=/home/coder` even while `USER root` is active in a later `RUN`
step — Docker's `USER` directive changes the effective UID, not the `HOME` env var, which
was already baked in by an earlier `ENV` in the base image. Any root-context `RUN` that writes
to `$HOME` (e.g. npm postinstall scripts) therefore writes into `/home/coder/...` as root,
which the `coder` user can't later write to. See
[docs/troubleshooting.md](troubleshooting.md#claude-directory-not-writable) for the fix
and how to spot it.

## Extension versioning

The extensions directory (`~/.local/share/code-server/extensions`) sits inside a per-project Docker
named volume, and Docker copies image content into a named volume *only on first attach*. A version
installed at image build time is therefore frozen at whatever the project's first launch seeded, and
`extensions.autoUpdate` is deliberately off (an auto-update would replace the boot-time patched
bundle with an unpatched one). Left alone, that combination means the extension can never be
updated at all — projects were found stuck on 2.1.212 and on 2.1.204/2.1.207 together.

So the version is explicit and reconciled at boot instead:

1. `CLAUDE_VERSION` in the [Dockerfile](../Dockerfile) pins one version for both the extension and
   the CLI, and its `linux-x64` VSIX is baked into the image at `/usr/local/share/shim/`, outside
   any volume.
2. [entrypoint-wrapper.sh](../container-assets/entrypoint-wrapper.sh) runs three idempotent,
   best-effort steps before code-server: `sync-user-settings.mjs` (re-applies the settings the image
   ships, since older volumes never received them), `sync-claude-extension.sh` (reinstalls the
   pinned VSIX offline when the volume's version differs, pruning stale extension directories), then
   `patch-claude-sidebar.mjs` (re-applies the side-bar resume patch to the current bundle).

Updating is `CLAUDE_VERSION` + rebuild + Stop/Launch (a mere restart keeps the old image). Bumps
need one check: the side-bar patch matches a specific minified call site and logs
`injection point not found (extension changed?)` when a release moves it.

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
