# VSCode Claude Shim — Launcher Daemon

Host-side broker daemon that manages per-project `code-server` + Claude Code container
instances. Exposes a narrow REST API and a browser-based launcher UI on
`http://127.0.0.1:4590`.

## Quick start

```powershell
cd daemon
npm install
npm run build          # Next.js production build for the launcher UI
npm start
```

Open http://127.0.0.1:4590. The daemon must be able to reach the Docker Desktop named pipe
(`//./pipe/docker_engine`) — Docker Desktop must be running.

## What it does

- **Starts & stops project-scoped code-server containers** on demand, each with its own
  isolated `.claude` home and its own bind-mounted project folder or `.code-workspace` file.
- **Launcher UI** (Next.js + React, embedded in the daemon process) — browse folders inside
  allow-listed roots, paste a path, see running instances, launch or stop them with one click.
- **Shared `~/.claude` allow-list** — `CLAUDE.md`, `.credentials.json`, `commands/`,
  `skills/`, and `sessions/` from the host are bind-mounted into every container. Everything
  else (history, projects, shell snapshots, browser profile) stays per-instance and isolated.
- **Stable per-project containers** — stopping and relaunching the same project reuses the
  same container name and `.claude` volume, so chat history survives a restart cycle.

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/roots` | List allow-listed roots (`{id, label}`). |
| `GET` | `/api/browse?root=<id>&path=<rel>` | Immediate children of one directory. |
| `POST` | `/api/browse/folder` | Create a new subfolder (`{root, path, name}`). |
| `GET` | `/api/resolve?path=<absolute>` | Validate a pasted path against roots. |
| `POST` | `/api/instances` | Launch a container (`{path}` or `{rootId, relativePath}`). |
| `GET` | `/api/instances` | List all managed containers (port + password included). |
| `GET` | `/api/recent` | Previously launched projects (survives container stop). |
| `POST` | `/api/instances/:id/stop` | Stop and remove a container. |
| `GET` | `/api/shim-settings` | Read the shim's `settings.json` (hooks configuration). |
| `PUT` | `/api/shim-settings` | Write the shim's `settings.json` (raw JSON body). |

## Configuration

### `roots.json`

Allow-listed host directories the daemon is permitted to mount into containers. Each entry
has:

- `id` — short slug used in URLs and container naming.
- `label` — human-readable name shown in the launcher UI's root picker.
- `hostPath` — absolute Windows path on the host.
- `containerPath` — path prefix inside the container (used only for workspace mounts).

A launch request for a path outside every configured root is rejected. The roots are a
**validation boundary only** — they are never mounted wholesale; each instance gets exactly
the bind mount(s) for the folder(s) actually requested.

### `shim-settings.json`

Holds the container-side `~/.claude/settings.json`, merged at launch with a forced
`{ autoInstallIdeExtension: false }` (that override cannot be removed — `code-server` has
no `code` binary). Editable at runtime via the launcher's Settings panel (raw JSON) or
`PUT /api/shim-settings`.

## Development

```powershell
npm run dev            # Next.js dev mode + Express, single process on :4590
npm test               # node:test runner — 17 unit tests for lib/paths.test.js
npm run build          # Next.js production build (only needed for npm start)
```

The launcher UI sources live in [launcher/](launcher/) as an npm workspace package with its
own `package.json` and `tsconfig.json`.

## Source layout

| File | Purpose |
|------|---------|
| [server.js](server.js) | Express app — API routes + Next.js custom server |
| [lib/paths.js](lib/paths.js) | Host-path validation, root matching, container-path translation |
| [lib/paths.test.js](lib/paths.test.js) | Unit tests for paths.js (17 tests) |
| [lib/browse.js](lib/browse.js) | `GET /api/browse` + `POST /api/browse/folder` logic |
| [lib/workspace.js](lib/workspace.js) | `.code-workspace` rewriting for container paths |
| [lib/claudeHome.js](lib/claudeHome.js) | `~/.claude` allow-list mount builder |
| [lib/docker.js](lib/docker.js) | Container lifecycle via `dockerode` (named pipe, no shell) |
| [lib/history.js](lib/history.js) | Recently-launched project list |
| [lib/shimSettings.js](lib/shimSettings.js) | Read/write/merge `shim-settings.json` |
| [roots.json](roots.json) | Allow-listed host roots |
| [shim-settings.json](shim-settings.json) | In-container `~/.claude/settings.json` template |
| [launcher/](launcher/) | Next.js + React launcher UI (npm workspace) |

## Architecture decisions

See [docs/plan-launcher-daemon.md](../docs/plan-launcher-daemon.md) for the full design
rationale, including:

- Why a host-side daemon instead of exposing the Docker socket into the container (security).
- Why no idle-instance auto-stop for v1 (manual stop only).
- Why `~/.claude` is partially shared rather than fully shared or fully isolated.
- Why a stable per-project id (SHA-256 of `rootId` + `relativePath`) instead of a random
  UUID for container naming.
- Why the launcher is a Next.js custom server embedded in the daemon process rather than a
  separate process or static export.
- Parked research: could the CLI run on the host instead of in each container.