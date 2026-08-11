# Mini Launcher

A small host-side Next.js app for launching and managing a single pinned folder in VSCode Claude Shim.

It serves on `127.0.0.1:4591`, manages `code-server` containers directly through Docker Desktop, and does **not** depend on the main launcher on port `4590`. It supports exactly one plain folder target only: no root browser, no recent list, and no `.code-workspace` support.

## What it does

- Runs as a Next.js app using TypeScript/React and the Pages Router
- Talks directly to Docker Desktop via `dockerode` in `lib/docker.ts`
- Reuses path-validation and mount-building logic from `../launcher/lib/`
- Launches managed containers for one pinned host folder

## Prerequisites

1. Docker Desktop is running.
2. The image `vscode-claude-shim:latest` is built.
   - From the repo root:
     - `docker compose up -d --build`
     - or `docker build -t vscode-claude-shim:latest .`
3. `../launcher/roots.json` is configured.
   - Roots are loaded relative to the current working directory as `../launcher/roots.json`.
   - The pinned folder must live under one of those configured roots, or the page shows an error.
4. The pinned target is set in `lib/config.ts`.
   - Configure `PINNED_HOST_PATH` and `PINNED_DISPLAY_PATH`
   - `PINNED_DISPLAY_PATH` is a Windows path
   - The target must exist on the host and be inside a configured root
5. Dependencies are installed:
   - `npm install`

## Run

### Development

```bash
cd mini-launcher
npm run dev
```

This runs `next dev -p 4591`.

Open: http://localhost:4591

### Production

```bash
npm run build
npm start
```

Also serves on port `4591`.

### Gotchas

When started as a background task, the dev-server log file can stay empty even though the server is up. Diagnose via HTTP/port, not the log.

Do not run `npm run build` while `npm run dev` is up — they share `.next`, and the dev server starts answering `500` on every route at its next recompile.

See `../docs/troubleshooting.md`.

## Stable URL through Caddy

Each instance also gets a stable, bookmarkable URL that survives restarts:

```
http://<slug>.mini-launcher.carlintveld.localhost
```

The published `localhost:<port>` stays as a fallback, because Docker hands out a **new random host port on every container start** — that link breaks after each restart, and its changing origin means the browser treats each restart as a different site.

`<slug>` is derived deterministically from the root id and relative path (e.g. `experiments-2026-07-vscode-shim-tester`) and doubles as the container's Docker network alias.

### How it works

- Caddy needs **one route for all projects**, because it accepts placeholders in the upstream address: the request's own subdomain label becomes the upstream host, resolved over Docker DNS to the container's alias. New projects need no proxy change.
- `lib/proxy.ts` installs that route through Caddy's admin API and re-installs it whenever it is missing — a Caddy restart re-adapts its Caddyfile and drops runtime config, and Caddy sends no notification. The check is a single `GET /id/shim-wildcard` (`404` = absent), memoized for 30s, run on launch and on the instance-status poll the UI already does every 5s.
- If Caddy is unreachable, or its container is not attached to the shared network, the launcher reports no stable URL and the UI offers the port link instead — it never hands out a link that cannot work.

### Prerequisites

Nothing per project, but the proxy container has to share the network once:

```sh
docker network connect shim-net caddy-proxy
```

The launcher creates `shim-net` and attaches instances itself. Without this step the API logs the exact command to run and falls back to the port URL.

### Configuration

| Env var | Default |
| --- | --- |
| `SHIM_PROXY_DOMAIN` | `mini-launcher.carlintveld.localhost` |
| `SHIM_PROXY_NETWORK` | `shim-net` |
| `SHIM_PROXY_CONTAINER` | `caddy-proxy` |
| `SHIM_CADDY_ADMIN` | `http://127.0.0.1:2019` |

Any `*.localhost` name resolves to 127.0.0.1 in Chromium without hosts-file entries and still counts as a secure context over plain HTTP, so no TLS is involved.

### Verifying

- `_probe-origin.mjs` — loads the workbench under a given host name and asserts it actually connected.
- `_probe-proxy-outage.mjs` — deletes the route under an open workbench, repairs it, and shows the page reconnecting on its own.

## UI overview

The app is a single pinned-project page with three main pieces:

### `PinnedTargetCard`

Launches the pinned folder. This starts a managed container named `shim-<id>` on a random host port.

### `PinnedInstancesList`

Shows the running instance and lets you stop it.

### `ClaudeSessionsList`

Lists Claude sessions for the pinned folder.

Each session row has:

- **Editor**
- **Side bar**

There is also a header button:

- **Open Claude in side bar**

This opens a fresh side-bar conversation.

## How session-opening works

`code-server` cannot deep-link into an extension chat panel by URL. Instead, the launcher writes a JSON signal file inside the container at:

`~/.claude/.shim-open-session`

Shape:

`{ sessionId, ts, target }`

- `ts` is an epoch-ms nonce
- re-clicking the same session still triggers a fresh action

This write is done by `signalOpenSession()` in `lib/docker.ts`, using base64 through `docker exec`.

A baked-in companion extension, `shim-session-opener`, reads that signal:

- at startup for a fresh window
- via a file watcher for an already-open window

Request flow:

1. A UI button calls `POST /api/session-open`
2. The API validates:
   - the pinned target resolves and exists
   - the session exists, when an id is provided
   - the instance is running
3. It calls `signalOpenSession()`
4. It returns the container URL

### Open session in editor

Used by the per-row **Editor** button.

- Signal: `target: "editor"`
- The opener extension runs:
  - `claude-vscode.primaryEditor.open <sessionId>`
  - fallback: `claude-vscode.editor.open`

Result: the session resumes in a full editor tab.

### Open session in side bar

Used by the per-row **Side bar** button.

- Signal: `target: "sidebar"` with a `sessionId`
- The opener extension runs `claude-vscode.sidebar.open`

That command only reveals the side bar view. It does not open a chosen session by itself, so the shipped extension bundle is patched at container startup by:

- `container-assets/patch-claude-sidebar.mjs`
- run via `container-assets/entrypoint-wrapper.sh`

The patched side bar `getHtmlForWebview` reads the same signal file and injects the session id as `data-initial-session` on the webview root, which the React app resumes.

**Limitation:** this works on a fresh window, which matches the launcher's flow. It does not switch an already-resolved side bar live.

Because the extension lives in a runtime volume, the patch re-runs every boot. Extension auto-update is pinned off in the `Dockerfile`, so the loaded version cannot drift ahead of the patched one. The version itself comes from the `CLAUDE_VERSION` build arg and is reconciled into the volume at each boot by `container-assets/sync-claude-extension.sh` — see [Extension versioning](../docs/architecture.md#extension-versioning) for why the volume would otherwise stay frozen on the version of its first launch.

To move to a newer extension: bump `CLAUDE_VERSION`, rebuild the image, then **Stop** and **Launch** the instance. Stop removes the container; a plain restart would keep running the old image.

### Dock Claude in the side bar, fresh

Used by the header **Open Claude in side bar** button.

- Signal: `target: "sidebar"` with no id
- Command: `claude-vscode.sidebar.open`

Result: Claude opens as a fresh side-bar conversation.

## References

- `../docs/re/mini-launcher/session-open-bridge.md` — full reverse-engineering write-up of the open bridge
- `../docs/architecture.md` — where the mini-launcher fits in the overall system
- `../docs/troubleshooting.md` — dev-server log gotcha and Docker Desktop recovery
