# Plan: multi-project launcher daemon

Status: build order items 1-2 implemented and manually tested end-to-end (single instance).
Item 3 (launcher page) is next. This doc captures the decisions made in the design session, plus
what changed/was discovered while implementing, so the next session can pick up without
re-deriving anything.

## Problem

The current setup hardcodes a single bind-mounted project folder (`./project` in
`docker-compose.yml` and the `CMD` in `Dockerfile`). Switching to a different host folder
requires editing those files and recreating the container. The goal is to make switching
between projects (across two drives: the git working copy and two OneDrive roots) easy,
without ballooning memory usage or widening the container's filesystem access beyond what's
actually needed for the project in question.

## Decisions made (in order they were settled)

1. **No shared memory across code-server instances.** Each `code-server` instance is a
   separate Node process (plus its own extension host and Claude CLI subprocess); the ~1GB+
   footprint is mostly per-process V8 heap, not shared library pages. Running N instances
   costs ~N × 1GB. This ruled out "just run several instances all the time" as a memory
   strategy.
   Relativized later: the Windows host already runs a battery of independent `claude` CLI
   processes outside this project as a matter of normal usage, so one more per-instance CLI
   subprocess isn't a new class of overhead — it's the existing pattern on this host. This is
   part of why the "run the CLI on the host instead" research thread below was deprioritized
   in favor of just building the launcher with each instance's regular bundled CLI.
2. **Docker cannot hot-add a bind mount to a running container.** Switching folders always
   means either recreating the container (fast, image is cached) or using VS Code's own
   "Open Folder" within whatever is already mounted. There is no live "attach a new volume"
   API.
3. **Rejected: exposing the Docker socket into the sandbox container** (sibling-containers
   pattern) to let the container spin up other containers itself. Docker socket access is
   host-root-equivalent — unacceptable given the container runs an AI agent that executes
   arbitrary shell commands.
4. **Adopted instead: a small host-side broker daemon** with a narrow, purpose-built API
   (not a Docker-socket proxy) that can only start/stop project-scoped code-server instances.
   Runs as a plain Node.js process on the Windows host for now; could move into its own
   container later. Talks to Docker Desktop via the Windows named pipe (e.g. `dockerode`),
   not by shelling out to `docker` with string-concatenated arguments (avoid injection).
5. **`roots.json`** — allow-listed host root directories. These are a **validation boundary
   only**, not something that gets bind-mounted wholesale (see decision 6). Confirmed roots:
   ```json
   {
     "roots": [
       { "id": "github", "hostPath": "C:\\work\\git\\github\\cveld", "containerPath": "/workspaces/github" },
       { "id": "onedrive-business", "hostPath": "C:\\Users\\CarlintVeld\\OneDrive - CloudNation", "containerPath": "/workspaces/onedrive-business" },
       { "id": "onedrive-personal", "hostPath": "C:\\data\\PersonalOneDrive\\OneDrive", "containerPath": "/workspaces/onedrive-personal" }
     ]
   }
   ```
   Note: `C:\Users\CarlintVeld\OneDrive` (no suffix) is a near-empty leftover from before the
   personal OneDrive was relocated — not a root.
6. **Least-privilege mounting, decided after pushback on "mount all roots always".** Every
   launched instance gets exactly the bind mount(s) for the folder(s) actually requested —
   never a whole root:
   - Plain folder launch → one bind mount, straight to `/home/coder/project` (matches
     today's layout, no root-prefix path needed since there is only one folder).
   - `.code-workspace` launch → each `folders[].path` entry resolved to an absolute host
     path (relative entries resolve against the workspace file's own directory), validated
     against the roots, and individually bind-mounted at
     `/workspaces/<root-id>/<relative-path-from-root>`. Any folder falling outside all
     configured roots rejects the whole workspace (fail closed).
   - The workspace file itself is **regenerated on every launch** (paths rewritten to their
     container equivalents) into a temp file (e.g.
     `%LOCALAPPDATA%\vscode-shim\workspaces\<hash>.code-workspace`) and bind-mounted
     read-only into the container. The host original stays the single source of truth — no
     caching/staleness risk.
7. **Launcher discovery: lazy drill-down, not a recursive pre-scan.** A recursive scan of a
   large root (especially the personal OneDrive, which has no project structure at all)
   would be slow and produce a noisy, mostly-irrelevant list, and heuristics like "has a
   `.git` folder" don't generalize to non-code roots. Instead:
   - `GET /api/browse?root=<id>&path=<relative>` returns only the immediate children
     (subfolders + any `*.code-workspace` files) of that one directory — one `readdir` per
     click, nothing pre-computed.
   - `GET /api/resolve?path=<pasted absolute path>` lets the user paste a path directly
     (stripping surrounding quotes from Explorer/PowerShell copies, normalizing slashes),
     validates it against the roots, checks it exists via `fs.stat`, and returns
     `{ rootId, relativePath, type: "folder" | "workspace" }` so the UI can jump straight
     there or offer to open it, instead of requiring manual click-through.
8. **No idle-instance auto-stop.** Explicitly decided: stopping instances is manual, via the
   launcher or a CLI command. No activity-detection mechanism needed for v1.
9. **`~/.claude` sharing: allow-list specific files, not the whole directory.** Rationale:
   Claude Code uses raw filesystem primitives inside the container, so there is no way to
   "softly" restrict what it can read within a directory that's actually mounted — the only
   real boundary is what's in the container's mount namespace at all. A listing of the real
   `~/.claude` on this host showed `projects/`, `sessions/`, `history.jsonl`,
   `shell-snapshots/`, `todos/`, `file-history/`, `backups/`, and `chrome/` (a browser
   profile, likely with cookies) — all of which mix data across unrelated projects/customers
   (e.g. `Customers/IGH` vs `Customers/Novulo`). Sharing all of `~/.claude` would let an
   instance scoped to one customer's project read another customer's session history.
   Decided instead: every instance keeps its own isolated `/home/coder/.claude/` (as today),
   with exactly four host paths bind-mounted on top of it:
   - `~/.claude/CLAUDE.md` → `/home/coder/.claude/CLAUDE.md` (read-only) — global
     instructions.
   - `~/.claude/.credentials.json` → `/home/coder/.claude/.credentials.json` (read-write, so
     token refresh inside the container writes back to the same file the host CLI uses).
   - `~/.claude/commands/` → `/home/coder/.claude/commands/` (read-write) — user's own
     tooling, not customer data; tiny (~0.02 MB on this host), so no meaningful footprint or
     isolation cost. Read-write so a session that creates/edits a command propagates back to
     the host and to every other instance.
   - `~/.claude/skills/` → `/home/coder/.claude/skills/` (read-write) — same rationale as
     `commands/` (~0.01 MB on this host).
   `settings.json` stays the image-baked version (`{"autoInstallIdeExtension": false}`) —
   deliberately **not** bind-mounted from the host, so this container-specific override isn't
   silently overwritten by whatever the host's copy contains.
   Accepted tradeoff: `commands/`/`skills/` are shared read-write across all concurrently
   running instances. Considered low-risk — these are small, infrequently, manually-edited
   text files, not high-frequency writes, so a write-write conflict between two sessions is
   unlikely. Same pattern already accepted for `.credentials.json`.

   **Addendum — `sessions/` re-included, and `settings.json` is now generated, not baked.**
   Motivated by making the host's Claude Code Dashboard (`C:\work\git\github\cveld\claude-code-dashboard`,
   a separate repo) inbox-monitor pattern work for shim sessions too:
   - `~/.claude/sessions/` is now shared read-write with every instance (see
     [claudeHome.js](../daemon/lib/claudeHome.js)), reversing part of decision 9's original
     exclusion list. The dashboard app writes `<session-id>-inbox.jsonl` here on the host; a
     container's own Claude session (same directory, same file) can tail it exactly like a
     native host session would — no per-instance mount plumbing needed once Claude's own
     session id is the shared key. Accepted tradeoff, deliberately re-weighed against decision
     9's original concern: this folder holds pid/cwd/inbox-message metadata, not transcripts —
     meaningfully smaller exposure than `projects/`/`history.jsonl`, which stay excluded.
   - `settings.json` is no longer only the image-baked default. [daemon/shim-settings.json](../daemon/shim-settings.json)
     holds Linux-adapted hooks (SessionStart inbox monitor via
     [container-assets/shim-inbox-monitor.sh](../container-assets/shim-inbox-monitor.sh),
     baked into the image; Stop/Notification/PermissionRequest posting to
     `http://host.docker.internal:3000/api/hooks` instead of `localhost` — a container's
     loopback isn't the host's). [lib/shimSettings.js](../daemon/lib/shimSettings.js) merges it
     with a forced `{ autoInstallIdeExtension: false }` and regenerates a temp file mounted
     read-only on every launch (same "host original stays the source of truth" pattern as
     `.code-workspace` regeneration) — preserving decision 9's actual safety property (that
     setting can never be silently overridden) while no longer freezing the rest of the file at
     image-build time. Editable via the launcher's Settings panel
     ([GET](../daemon/server.js)/`PUT /api/shim-settings`, raw JSON textarea by choice — no
     structured form for v1).
   - `python3 -c` in the original Windows/Mac hook scripts became `node -e` in the container
     variant — the image has Node (required by the CLI) but no Python, and adding one just for
     this would be a new dependency for no reason.

## Parked: could the CLI run on the host instead of in each container?

Raised in the design session, then deprioritized: see the relativized memory argument in
decision 1 above — since the host already runs a battery of independent CLI processes as
normal usage, the per-instance CLI subprocess isn't worth the added complexity of this
approach for v1. Kept here as a possible future optimization, not a blocker for the build
order below.

Two distinct mechanisms were identified, very different confidence levels:

1. **Lock-file/WebSocket IDE-detection protocol** (documented in
   [docs/re/ide-protocol.md](re/ide-protocol.md), already reverse-engineered): the extension
   runs a `127.0.0.1`-only WebSocket/MCP server and writes a lock file to
   `~/.claude/ide/<port>.lock` (pid, port, authToken); any CLI process scans that directory
   and connects if the lock file looks live. In principle, if `~/.claude/ide/` is shared
   between host and container (it already would be, being inside `~/.claude`, if we ever
   widen the allow-list — currently it is *not* shared per decision 9, so this needs adding
   just for this experiment) and the container's WS port is forwarded to the identical port
   number on the host's `127.0.0.1`, a `claude` CLI run natively on the Windows host could
   discover and connect to the extension's server with **zero new code**, purely via existing
   protocol. The one known unknown: the lock file's `pid` is inside the container's own PID
   namespace and won't resolve to anything in the host's process table; the CLI's staleness
   check might therefore delete the lock file as dead before connecting. The docs show a
   special case for WSL for what looks like the same class of problem, which may or may not
   extend to this scenario — **this needs an actual empirical test, not more code reading.**
2. **Redirecting the extension's own embedded-chat CLI subprocess to the host** — this is
   likely the heavier of the two per-instance processes, so this is the one that would
   actually move the memory needle. Not investigated yet: is the CLI binary path configurable
   via an extension/CLI setting, and what transport does the extension use to talk to its
   spawned child (stdio? JSON-RPC?)? Would need reading `extension.js` for the spawn call
   itself, not just the IDE-detection path already documented.

If revisited later: the cheap experiment for (1) would be to mount `~/.claude/ide/` from host
into a running instance, forward its WS port 1:1 to the host loopback, start a bare `claude`
in a host PowerShell terminal, and see whether it picks up the container's lock file (open
unknown: the lock file's `pid` is inside the container's PID namespace and won't resolve on
the host, which might make the CLI treat it as stale).

## Implemented so far (`daemon/`)

Build order items 1, 2 and 4 are done:

- [daemon/roots.json](../daemon/roots.json) — the three roots from decision 5, as literal
  config (not hardcoded in JS).
- [daemon/lib/paths.js](../daemon/lib/paths.js) — pure validation/translation module: quote
  stripping, `..`-resolving, case-insensitive boundary-aware root matching (fails closed on
  paths outside every root, and does not treat a sibling like `cveldX` as inside `cveld`),
  root-relative ↔ container-path translation, `.code-workspace` classification by extension.
  14 unit tests in [daemon/lib/paths.test.js](../daemon/lib/paths.test.js) (`npm test`), all
  passing, including the OneDrive root whose name contains a space.
- [daemon/lib/browse.js](../daemon/lib/browse.js) — `GET /api/browse` logic (decision 7):
  one `readdir` per call, re-validates the resolved path against the root as a defensive
  re-check on the API param.
- [daemon/lib/workspace.js](../daemon/lib/workspace.js) — `.code-workspace` rewriting
  (decision 6): resolves each `folders[].path` against the workspace file's own directory,
  fails closed (throws, rejecting the whole workspace) if any folder is outside every root,
  writes the rewritten file to `%LOCALAPPDATA%\vscode-shim\workspaces\<hash>.code-workspace`.
- [daemon/lib/claudeHome.js](../daemon/lib/claudeHome.js) — builds the four allow-listed
  `~/.claude` mounts from decision 9, skipping (with a console warning) any that don't exist
  on the host yet rather than failing the mount.
- [daemon/lib/docker.js](../daemon/lib/docker.js) — talks to Docker Desktop's Windows named
  pipe via `dockerode`. No in-memory instance registry: `listInstances()` always re-queries
  `docker ps` filtered on label `shim.managed=true`, so a daemon restart needs no recovery
  code path at all. Two decisions made during implementation, not in the original design:
  - **Stable per-project id** (`sha256(rootId + relativePath).slice(0,12)`), not a random
    UUID — relaunching the same folder/workspace reuses the same container name and the same
    `.claude` named volume, so chat history survives a stop/relaunch cycle, and launching an
    already-running project fails on a Docker name conflict instead of silently creating a
    duplicate.
  - **Random per-instance password** (`crypto.randomBytes(9)`, returned once in the launch
    response, stored in a `shim.password` label for later retrieval via `GET
    /api/instances`), replacing the hardcoded `changeme` from `docker-compose.yml`.
- [daemon/server.js](../daemon/server.js) — wires the above into the five HTTP endpoints,
  listening on `127.0.0.1:4590`.
- `docker-compose.yml` now has an explicit `image: vscode-claude-shim:latest` (build order
  item 4, pulled forward because the daemon needs a stable tag to reference from `dockerode`).

Manually verified end-to-end (single instance): browse → resolve → launch → inspected the
running container's `/home/coder/.claude` (CLAUDE.md/commands/skills/.credentials.json present,
`settings.json` is the image-baked version, `projects/`/`sessions/` absent — isolation holds)
and `/home/coder/project` (correct folder mounted) → list → stop → confirmed the container is
gone. The `.code-workspace` launch path (`lib/workspace.js` + the corresponding branch in
`createInstance`) is implemented but has **not** been exercised end-to-end yet — no real
`.code-workspace` file was launched in this session's test.

**Open question surfaced during implementation, now resolved**: the original decision 6/
build-order text said every instance gets "the shared `code-server-config` volume as today" —
but `daemon/lib/docker.js` didn't mount one at all for a while, because with concurrently
running instances a single shared volume means multiple `code-server` processes writing to the
same `state.vscdb` (SQLite) concurrently, which risks corruption in a way that never came up
with today's single-instance compose setup. Resolved by mirroring the `.claude` volume pattern
exactly: a **per-instance** named volume `shim-vscode-config-<id>` (same stable project id as
`shim-claude-<id>`), created idempotently (`createVolume` + swallow the 409) and mounted at
`/home/coder/.local/share/code-server`. UI layout/recently-opened now persists across a
project's own stop/relaunch cycles, with no cross-instance write contention. Not yet manually
verified end-to-end (see item 6 below).

## Build order

1. ~~`roots.json` + path-validation/translation module.~~ **Done.**
2. ~~Host daemon (browse/resolve/instances API over `dockerode`).~~ **Done**, including the
   `code-server-config` open question above.
3. ~~Launcher page — root list → drill-down browser + paste-path box → running-instances list
   with stop buttons.~~ **Done.** Superseded decision: originally planned as a vanilla-JS
   static page (no bundler) — revised per explicit user preference for Next.js/TypeScript/React
   instead. Chosen integration: **Next.js custom server, embedded in the daemon process** (not a
   separate always-running Next process, not static export) — [daemon/server.js](../daemon/server.js)
   calls `next({ dev, dir: 'launcher' })` and, after all `/api/*` routes, falls through to
   Next's request handler via a path-less `app.use(...)` (Express 5 dropped bare `'*'` wildcard
   routes — `path-to-regexp` now requires a named wildcard like `/*splat`, so a path-less
   middleware is simpler and equivalent here), so there is still exactly one process/port
   (`127.0.0.1:4590`) in both dev and production. The Next app itself lives in
   [daemon/launcher/](../daemon/launcher/) as its own npm-workspace package (own
   `package.json`/`tsconfig.json`), linked into the daemon via npm workspaces
   (`daemon/package.json` declares `"workspaces": ["launcher"]`) so `next`/`react`/`react-dom`
   resolve from the daemon's own `node_modules` without duplicating installs. Pages Router (not
   App Router) — this is a single client-side dashboard fetching the existing REST API, no SSR
   data needs.
   Two small additive API changes support the browser-driven launch flow (drilling down never
   produces a raw absolute host path, only `rootId`/`relativePath`): `GET /api/roots` (returns
   `{id, label}` for the root picker — deliberately not `hostPath`, keeping real filesystem
   paths a server-only concern per decision 5, backed by a new `label` field added to each
   entry in `roots.json`) and `POST /api/instances` now also accepts `{ rootId, relativePath }`
   as an alternative body shape to the existing `{ path }` raw string, both funneled through
   the same `resolveHostPath` validation (new `toHostPath()` in
   [daemon/lib/paths.js](../daemon/lib/paths.js), the inverse of `resolveRoot`, with its own
   unit tests).
   The UI ([daemon/launcher/pages/index.tsx](../daemon/launcher/pages/index.tsx) +
   `components/RootBrowser.tsx` + `components/InstancesList.tsx`) surfaces the port + password
   in the running-instances table (polls `GET /api/instances` every 5s, plus an immediate
   refresh after a launch/stop) — the password is retrievable any time from the `shim.password`
   label, not truly one-time.
   Verified: `npm install`, `npm test` (17/17 passing, including new `toHostPath` tests),
   `npm run build` (Next production build + typecheck clean), then `npm start` against the real
   Docker daemon on this host — confirmed `GET /api/roots`, `GET /api/browse`, `GET
   /api/instances`, and `GET /` (page HTML with correct `<title>`, hydration data) all served
   correctly from the one process. **Not yet exercised**: an actual launch/stop click-through in
   a real browser (only the underlying API calls were curled), and the paste-path-box → resolve
   → launch path for a `.code-workspace` file.
4. ~~Stable explicit `image:` name in `docker-compose.yml`.~~ **Done.**
5. Update `README.md` / `docs/architecture.md` with the new usage model; the existing
   single-instance `docker compose up -d` flow should keep working unchanged for local dev of
   this project itself.
6. ~~Resolve the `code-server-config` open question above and implement it.~~ **Done**
   (`daemon/lib/docker.js`), not yet exercised end-to-end (see item 7).
7. End-to-end tests not yet done:
   - **Two concurrent instances** for two different projects — confirm instance A cannot see
     instance B's project files, and (now relevant because of item 6) confirm two instances
     don't corrupt each other's `code-server-config` state.
   - **A real `.code-workspace` launch** — the code path exists but was never actually
     exercised against a real multi-folder workspace file in this session.
