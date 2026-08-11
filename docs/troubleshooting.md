# Troubleshooting

## `~/.claude` directory not writable

**Symptom:** extension sidebar OAuth (device-code) fails with "failed to retrieve auth status
after login". CLI login itself may still silently succeed (check `~/.claude.json` for a
populated `oauthAccount`), but anything the extension/CLI needs to persist under
`~/.claude/` (credentials, sessions, and critically the `~/.claude/ide/*.lock` file used for
IDE detection) fails.

**Root cause:** see [architecture.md](architecture.md#image-layering-gotcha) — a root-context
`RUN npm install -g @anthropic-ai/claude-code` in the Dockerfile created `/home/coder/.claude`
as root (mode `755`), which the `coder` user can list but not write into.

**Diagnose:**
```sh
docker exec <container> bash -lc 'ls -la ~/.claude; touch ~/.claude/ide/probe 2>&1'
```
If this reports `Permission denied` / the directory is `root root`, this is the bug.

**Fix:** run the root-context npm install with `HOME=/root` so it never touches
`/home/coder`, and defensively remove `/home/coder/.claude` before switching to `USER coder`.
See [Dockerfile](../Dockerfile).

**Caveat:** if you already ran the broken image once, the named `claude-config` Docker volume
may have had the bad root-owned directory copied into it on first mount (Docker only
auto-populates a volume from the image once). Removing the volume
(`docker compose down -v`) forces a clean re-populate from the fixed image.

## `code --force --install-extension anthropic.claude-code` crashes after login

**Symptom:** after a successful `claude` CLI login (device code), it immediately fails with:
```
✘ Error installing VS Code extension: 1: Command failed with
  ERR_STREAM_PREMATURE_CLOSE: code --force --install-extension anthropic.claude-code
```

**Root cause:** the CLI has a feature, `autoInstallIdeExtension` ("Auto-install IDE
extension"), that shells out to a `code` binary to (re)install its companion extension when
running inside a detected IDE terminal. code-server has no `code` binary on `PATH` — only
`code-server` (see [docs/re/ide-protocol.md](re/ide-protocol.md)) — so the spawn fails.
This is cosmetic: the login itself already succeeded and persisted.

**Fix:** ship `~/.claude/settings.json` with `{"autoInstallIdeExtension": false}` in the
image — we already install the matching extension version ourselves, so the feature is
redundant here regardless.

## Red herring: `officialMarketplaceAutoInstall*` fields in `~/.claude.json`

While debugging the above, `~/.claude.json` showed
`officialMarketplaceAutoInstallAttempted/Failed/RetryCount/...` fields that look related but
aren't — per strings extracted from the `claude` binary, these track a *plugin marketplace*
auto-install (git/GCS-based), unrelated to the VS Code extension install path. Don't chase
these when debugging IDE-extension issues.

## Express 5 `app.all('*', ...)` throws at startup

**Symptom:** `PathError [TypeError]: Missing parameter name at index 1: *` (from
`path-to-regexp`, thrown via `router/lib/layer.js`) as soon as the launcher starts, pointing at
a catch-all route registration.

**Root cause:** Express 5 upgraded its router to a `path-to-regexp` version that no longer
accepts a bare `'*'` as a full route path — wildcards now require a name (e.g. `/*splat`).
Code written against Express 4 idioms (`app.all('*', handler)`, e.g. for a catch-all that
delegates to another request handler) throws immediately on Express 5.

**Fix:** use a path-less `app.use((req, res) => handler(req, res))` instead — it matches every
request without any route-path syntax at all, and is what you actually want for a pure
catch-all (e.g. delegating unmatched requests to the launcher UI request handler).

## Launcher dev server: background task log stays empty even though it's up

**Symptom:** after starting `npm run dev` (or `npm start`) as a background shell task, the
captured stdout log still shows only the `npm` banner for tens of seconds later — no launcher
startup line ever appears, even though the process hasn't crashed.

**Root cause:** not a startup failure — this is Node's/npm's stdout buffering interacting
with how the background-task log file is captured on Windows. The launcher's `console.log`
does eventually fire; it just isn't reliably flushed to the redirected log file on the
timescale you're polling at.

**Diagnose, don't trust the log file:**
```powershell
Get-NetTCPConnection -LocalPort 4590 -ErrorAction SilentlyContinue | Format-Table -AutoSize
```
or
```sh
curl -s -w "\nHTTP %{http_code}\n" http://127.0.0.1:4590/api/roots
```
If either confirms the port is listening / the API responds, the daemon is up regardless of
what the log file shows.

## Workspace trust dialog reappears every session

**Symptom:** every time you start a fresh browser session (or reload the workbench), code-server
asks "Do you trust the authors of this folder?" again, even though it's always the same
`/home/coder/project` folder and you already answered this before.

**Root cause:** VS Code's workspace trust decision is meant to be remembered per-workspace, but
inspecting a running container showed no `state.vscdb`/global storage state was ever written
under `~/.local/share/code-server/User/globalStorage` — despite that directory living inside the
persisted `code-server-config` volume — and each window open created a new numbered
`workspaceStorage/<hash>-N` folder instead of reusing one. In practice trust never sticks here.

**Fix:** ship `~/.local/share/code-server/User/settings.json` with
`{"security.workspace.trust.enabled": false}` in the image (see [Dockerfile](../Dockerfile)) —
this is a disposable single-project container, so the trust prompt has no value and disabling it
is simpler than chasing why the trust decision itself doesn't persist.

**If you already have a populated `code-server-config` volume from before this fix:** the image
write only applies on first volume populate, so older volumes never received the file — one was
found with no `User/settings.json` at all, which also left extension auto-update enabled there.
[container-assets/sync-user-settings.mjs](../container-assets/sync-user-settings.mjs) now merges
the required keys into the volume's `settings.json` at every container start (preserving any other
keys), so no manual `docker exec` is needed; just restart the container and reload the browser tab.

## Launcher dev server answers 500 on every route after a production build

**Symptom:** `npm run dev` was working, then suddenly every route — including ones you did not touch,
like `/api/target` — returns `500` with Next's generic `_error` payload. Restarting the request does
not help; the failure appears at the first recompile after the build, not at the moment of the build.

**Root cause:** `next dev` and `next build` share the same `.next` directory. Running `npm run build`
against a live dev server replaces the artefacts underneath it, and the dev server breaks as soon as
it next recompiles.

**Fix:** stop the dev server, `rm -rf .next`, start it again. To verify a production build while
developing, stop the dev server first (or point the build at a separate `distDir`).

## Closing the browser tab kills the running Claude session

**Symptom:** you close the browser window, come back later, and the Claude conversation is gone —
the side bar opens a fresh, empty conversation, and whatever turn was running never finished. It
looks as if the instance stopped.

**What actually happens:** the container never stopped. `docker ps` still shows it `Up`, and
code-server is still running — only the launcher's Stop button removes a container. What died is the
VS Code extension host, which the workbench tears down on page unload, taking the Claude extension
and its `claude` CLI subprocess with it within ~3s.

**Fix (in the image since the keep-alive patch):**
[container-assets/patch-workbench-keepalive.mjs](../container-assets/patch-workbench-keepalive.mjs)
suppresses that goodbye while the page is unloading, so a closed tab looks like a network drop and
the extension host keeps working under its 3h reconnection grace time. Verify with
[mini-launcher/_probe-exthost-keepalive.mjs](../mini-launcher/_probe-exthost-keepalive.mjs).

**Still true after the patch:** reopening the tab gives you a *new* extension host — it cannot
re-attach to the one that kept running, so the conversation comes back by resuming from session
history (the session-open bridge), not as a live attach. The window itself always starts fresh: the
editor layout is never restored (measured — a reopened, duplicated or crash-recovered tab all come
back with just the Welcome tab), because the workbench keeps its state in the browser's IndexedDB and
no `state.vscdb` is written container-side at all. The full reasoning is in
[docs/re/exthost-keepalive.md](re/exthost-keepalive.md).

**If the browser serves a stale bundle** after rebuilding the image (the asset path is keyed on the
code-server commit, which does not change when only its contents are patched), hard-reload the tab
once. The probe prints `keep-alive patch present in bundle: false` when this happens.

## Claude extension stuck on an old version

**Symptom:** the Claude Code extension inside a launcher-managed container stays on an old version
even after rebuilding `vscode-claude-shim:latest`, and the version never advances. Observed cases:
one project volume stuck at `2.1.212`, another carrying `2.1.204` and `2.1.207` side by side.

**Root cause:** the extension is installed under `/home/coder/.local/share/code-server/extensions`,
and that entire tree is a per-project Docker named volume (`shim-vscode-config-<id>`, created by
`mini-launcher/lib/docker.ts` / `launcher/lib/docker.js`). Docker copies image content into a named
volume only the first time that volume is attached, so the version is frozen at whatever the
project's first launch seeded — rebuilding the image cannot overwrite it. Auto-update is
deliberately off too (the boot-time side-bar patch rewrites the shipped bundle, and an auto-update
would load a newer, unpatched one), so nothing else refreshes it either.

**Fix:** the version is pinned by `CLAUDE_VERSION` in the [Dockerfile](../Dockerfile) — one build
arg for both the npm CLI and the extension VSIX, which Anthropic releases in lockstep. The pinned
VSIX is baked into the image *outside* any volume at `/usr/local/share/shim/claude-code.vsix`, and
[container-assets/sync-claude-extension.sh](../container-assets/sync-claude-extension.sh)
reinstalls from it at every container start when the volume's version doesn't match. That sync is
offline, idempotent, and prunes leftover older extension directories.

To update: bump `CLAUDE_VERSION`, rebuild, then **Stop** and **Launch** the instance in the launcher
UI. Restarting is not enough — a stopped container still runs the old image, and
`launchPinnedInstance` starts an existing container rather than recreating it. Stop removes the
container, so the next Launch builds a fresh one from the new image.

Inspect what a volume actually holds:
```sh
docker run --rm -v shim-vscode-config-<id>:/c alpine sh -c "ls /c/extensions"
```
`docker logs <container>` shows the `[sync-claude-extension]` lines reporting up-to-date vs
installed.

When bumping the version, check that the side-bar patch still applies:
[container-assets/patch-claude-sidebar.mjs](../container-assets/patch-claude-sidebar.mjs) matches a
specific minified call site and logs `injection point not found (extension changed?)` if a new
release moves it.

## Docker Desktop not running after a session interruption

If a background shell task shows as unexpectedly `stopped` and `docker ps` fails with
`failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`, Docker
Desktop itself exited (e.g. host sleep/session restart). The mini-launcher now has a Windows
fallback in `mini-launcher/lib/docker.ts`: before `inspect`, `launch`, or `stop`, it pings the
Docker named pipe and, if the pipe is missing, starts Docker Desktop from
`C:/Program Files/Docker/Docker/Docker Desktop.exe` and waits until `docker.ping()` succeeds.

If you are outside the mini-launcher flow, start Docker Desktop manually
(`Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe'`) and poll `docker info`
until it responds before resuming. Existing containers survive and just need
`docker compose up -d` again (no rebuild needed).
