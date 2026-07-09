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
`path-to-regexp`, thrown via `router/lib/layer.js`) as soon as the daemon starts, pointing at
a catch-all route registration.

**Root cause:** Express 5 upgraded its router to a `path-to-regexp` version that no longer
accepts a bare `'*'` as a full route path — wildcards now require a name (e.g. `/*splat`).
Code written against Express 4 idioms (`app.all('*', handler)`, e.g. for a catch-all that
delegates to another request handler) throws immediately on Express 5.

**Fix:** use a path-less `app.use((req, res) => handler(req, res))` instead — it matches every
request without any route-path syntax at all, and is what you actually want for a pure
catch-all (e.g. delegating unmatched requests to a Next.js custom-server request handler; see
[daemon/server.js](../daemon/server.js)).

## Daemon dev server: background task log stays empty even though it's up

**Symptom:** after starting `npm run dev` (or `npm start`) as a background shell task, the
captured stdout log still shows only the `npm` banner (`> dev\n> node server.js`) tens of
seconds later — no `[daemon] listening on ...` line ever appears, even though the process
hasn't crashed.

**Root cause:** not a startup failure — this is Node's/npm's stdout buffering interacting
with how the background-task log file is captured on Windows. The `console.log` call in
[daemon/server.js](../daemon/server.js) does eventually fire; it just isn't reliably flushed
to the redirected log file on the timescale you're polling at.

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
change only applies on first volume populate. Apply it manually once:
```sh
docker exec <container> bash -lc \
  'mkdir -p ~/.local/share/code-server/User && echo "{\"security.workspace.trust.enabled\": false}" > ~/.local/share/code-server/User/settings.json'
```
then reload the browser tab.

## Docker Desktop not running after a session interruption

If a background shell task shows as unexpectedly `stopped` and `docker ps` fails with
`failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`, Docker
Desktop itself exited (e.g. host sleep/session restart) — start it again
(`Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe'`) and poll `docker info`
until it responds before resuming. Existing containers survive and just need
`docker compose up -d` again (no rebuild needed).
