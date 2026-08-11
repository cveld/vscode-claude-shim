# RE: opening a specific Claude session from the mini-launcher

How clicking a session row in the mini-launcher lands you in **that exact session** inside the
code-server chat panel — and why it took a companion extension to get there.

## The problem

The mini-launcher lists a folder's Claude sessions (from `~/.claude/projects/<slug>/*.jsonl`).
Clicking one should open code-server *and resume that conversation in the Claude chat panel*.
The obvious approaches all fail in a browser-based (headless) VS Code:

- There is **no per-session URL** on code-server. `http://localhost:<port>/` only opens the
  workspace folder; the extension then starts a fresh conversation.
- The Claude extension *does* ship a deep link — `vscode://anthropic.claude-code/open?session=<id>`
  (registered via `window.registerUriHandler`; the handler runs
  `claude-vscode.primaryEditor.open <sessionId>`). But `vscode://` protocol URLs are only routed
  by a **desktop** OS protocol handler. code-server has none.
- code-server's only URL→extension bridge is `callback.html` +
  `localStorage['vscode-web.url-callbacks[<reqid>]']`, and its `checkCallbacks()` loop only fires
  for callbacks the **workbench itself started** (the `asExternalUri` round-trip used by OAuth).
  A cold URL carrying `vscode-scheme`/`vscode-authority`/`vscode-path` params is ignored because
  there is no matching pending `reqid`. So you cannot cold-dispatch an extension's `handleUri`.
- The panel's `WebviewPanelSerializer.deserializeWebviewPanel` restores with **no** session id
  (`setupPanel(panel, undefined, undefined, …)`), so a fresh browser always gets a new
  conversation. A session only "comes back" when the *same browser + same code-server volume*
  already had it open (client-side persisted webview state) — useless for picking an arbitrary
  historic session.
- The extension's MCP WebSocket server (the one `mini-launcher/pages/api/ide-proxy.ts` bridges
  to) exposes only IDE-side tools for the CLI — `openFile`, `openDiff`, `getDiagnostics`,
  `getOpenEditors`, … — **nothing** that opens/focuses a Claude session.

The one thing that *does* work is the command the deep link itself calls:
`claude-vscode.primaryEditor.open <sessionId>` (falls back to `claude-vscode.editor.open`). It
resumes the exact session in a full-editor Claude panel — verified by executing it and seeing the
prior transcript render (user prompt, thinking, tool calls, assistant reply). Under the hood the
extension spawns the CLI with `--resume=<id>`.

## The bridge: a baked-in companion extension

Since we can't reach that command from outside, a tiny extension runs it from *inside*:

- **`container-assets/shim-session-opener/`** — activates `onStartupFinished`, reads a signal
  file, waits for the Claude command to be registered, then executes it with the requested
  session id. It also `fs.watch`es the signal file so an already-open window switches sessions
  live (no reload).
- **Signal file**: `~/.claude/.shim-open-session`, JSON
  `{ "sessionId": "<uuid>", "ts": <epoch-ms>, "target": "editor" | "sidebar" }`.
  `ts` is a nonce so re-triggering the *same* request still fires (identical file contents
  wouldn't). `target` selects what the extension does (default `editor`) — see
  [Targets: editor vs side bar](#targets-editor-vs-side-bar).
- **The mini-launcher writes it**: `mini-launcher/lib/docker.ts#signalOpenSession()` runs
  `printf %s '<base64>' | base64 -d > ~/.claude/.shim-open-session` via `docker exec`
  (base64 avoids shell-quoting surprises). `mini-launcher/pages/api/session-open.ts` calls it
  after confirming the pinned instance is running, then returns the container-root URL with
  `openMode: "session"`. The browser opens that URL; on a fresh window the extension reads the
  signal at startup, so the click lands directly in the session.

### Flow

```
click row → POST /api/session-open { sessionId }
          → signalOpenSession() writes ~/.claude/.shim-open-session via docker exec
          → response { openUrl: http://localhost:<port>, openMode: "session" }
browser   → window.open(openUrl)  (fresh code-server window)
extension → onStartupFinished reads signal → claude-vscode.primaryEditor.open <id>
          → session resumes in the Claude panel
(already-open window: fs.watch fires on the rewrite → same command, no reload)
```

## Targets: editor vs side bar

The signal's `target` field picks what happens:

- **`editor`** (default) — resume the given session in a full editor panel via
  `claude-vscode.primaryEditor.open <sessionId>` (the verified resume path, above).
- **`sidebar`** — reveal Claude in the (secondary) side bar via `claude-vscode.sidebar.open`.
  With a `sessionId`, that session resumes **in the side bar** (via the bundle patch below); with
  no `sessionId`, it just docks a fresh conversation.

### Why resuming a session in the side bar needs a patch

Out of the box the extension offers no command for it — this is the wall:

- Session resume is bound to **editor panels**. `editor.open(sessionId, …)` and
  `primaryEditor.open(sessionId, …)` both call `createPanel(...)`, which keys panels by session
  id in a `sessionPanels` map. There is no analogous "open session id in side bar" command.
- The side bar view is a `WebviewViewProvider` whose HTML is built with **no** session
  (`getHtmlForWebview(webview, void 0, void 0, true)` — the session args are `void`), so it
  always renders a *fresh* conversation.
- Confirmed empirically: with Claude preferring the side bar, clicking a historic session in
  the sessions list (`claudeVSCodeSessionsList`) opens it as a **new editor tab**, not in the
  side bar chat.

Manually you *can* land a session in the side bar (set `preferredLocation` to side bar, open the
side bar's own history picker, click a session — all in-webview), but that path isn't reachable
as a VS Code command from outside.

### The bundle patch

The one lever is how `getHtmlForWebview` injects state: the session arg (2nd param) becomes
`data-initial-session="<id>"` on the webview's `#root`, and the React app resumes it — the same
mechanism editor panels use. The side bar view just hard-codes that arg to `void 0`.

So [`container-assets/patch-claude-sidebar.mjs`](../../../container-assets/patch-claude-sidebar.mjs)
rewrites exactly that one call site in the shipped `extension.js`:

```
this.getHtmlForWebview(e.webview, void 0,                      void 0, !0)   // before
this.getHtmlForWebview(e.webview, globalThis.__shimSidebarSession(), void 0, !0)   // after
```

The injected `__shimSidebarSession()` reads this same signal file and returns the id only for a
**fresh** (< 2 min) `target: "sidebar"` signal — so it never hijacks normal side bar use with a
stale signal. The regex matches only the 4-arg side bar form; the 6-arg sessions-list call
(`…,!1,!1,!0`) and editor panels (which pass a real session) are untouched.

**When/where it runs.** The extension installs into `~/.local/share/code-server/extensions/`,
which is a runtime **volume** — a build-time patch would be masked or frozen to one version. So
the patch runs at **container startup** from an entrypoint wrapper
([`entrypoint-wrapper.sh`](../../../container-assets/entrypoint-wrapper.sh) →
[Dockerfile](../../../Dockerfile)), idempotently, re-applying after any extension update.

**Flow for `sidebar` + `sessionId`.** Launcher writes the signal → fresh window → the
`shim-session-opener` runs `claude-vscode.sidebar.open` (reveals the view) → the patched
`resolveWebviewView` reads the signal and boots the side bar webview straight into that session.
Because it hooks the *build* of the webview HTML, it works on a fresh window (the launcher's case)
but not for switching an already-resolved side bar view live — an accepted limitation.

## Image-layering gotcha (important)

The extension **must** be baked into the built-in extensions dir
`/usr/lib/code-server/lib/vscode/extensions/shim-session-opener/`, **not**
`~/.local/share/code-server/extensions/`. The latter is a runtime Docker **volume**
(`shim-vscode-config-<id>`) that masks anything baked into the image at that path. The built-in
dir is on the image layer and is scanned for any folder with a `package.json` — no manifest entry
needed. See the `COPY` in [Dockerfile](../../../Dockerfile) and the related
[image layering gotcha](../../architecture.md#image-layering-gotcha).

## How this was verified

- Dropped a throwaway opener extension into a running container and drove code-server with
  headless Playwright (`--auth none`): the target session rendered in the panel.
- Confirmed built-in-dir discovery by moving the extension there and removing the volume copy —
  it still activated.
- Ran the full real path: `POST /api/session-open` → signal file written by `docker exec` →
  fresh Playwright load → the *other* session opened (distinct title), proving the signal drives
  the target rather than a cached/last-session restore.
- Verified both `target` values end-to-end against the live container by writing the signal and
  reloading headlessly: `editor` made the requested session tab appear on a fresh window (no tab
  before → the resumed session after); `sidebar` (no id) moved Claude from an editor panel into
  the secondary side bar (aux-bar title flipped to "Claude Code", the editor session tab dropped)
  — a transition only the extension could have caused.
- The **bundle patch** for `sidebar` + `sessionId` is validated offline: the patcher rewrites the
  one call site and is idempotent; the injected `__shimSidebarSession()` returns the id only for a
  fresh sidebar signal (and `undefined` for editor/stale/no-id, so normal side bar use is never
  hijacked). Its live end-to-end confirmation is **pending** (Docker Desktop was down at the time)
  — reload a fresh window with a `sidebar` + `sessionId` signal and assert the transcript renders
  inside the side bar webview.

## Caveats / future work

- Existing containers launched before this feature need one relaunch to pick up the baked
  extension.
- Today the launcher opens the container root and lets the extension focus the session. A future
  real per-session URL (if code-server ever gains cold URI dispatch, or the extension a web
  entry point) can slot in behind the same `/api/session-open` contract without a frontend
  change.

See also: [ide-protocol.md](../ide-protocol.md) for the lock-file / WebSocket detection the
`~/.claude/ide` mount and `ide-proxy`/`ide-locks` routes rely on.
