# Keeping the extension host alive when the browser window closes

Measured against code-server 4.131.0 (commit `a3fc2899bd0fcd388253c0e79ce33b8acd48c688`) in a live
container.

## Problem

Closing the browser tab does **not** stop the container — code-server keeps running, and the
instance stays `Up` until the launcher's Stop button removes it. What dies is the VS Code
**extension host**, and with it the Claude extension and the `claude` CLI subprocess it spawns:

```text
[16:26:11] [172.17.0.1][f459869a][ManagementConnection] The client has disconnected gracefully, so the connection will be disposed.
[16:26:14] [172.17.0.1][7714d7f4][ExtensionHostConnection] <101> Extension Host Process exited with code: 0, signal: null.
```

Exit code 0 with no signal means it went by itself, and its own log
(`~/.local/share/code-server/logs/<ts>/exthostN/remoteexthost.log`) says why:

```text
Extension host terminating: received terminate message from renderer
```

## Why the stock build is almost ready for this

Both halves are already built for surviving a *dropped* client. The server passes
`VSCODE_RECONNECTION_GRACE_TIME` (default `10800000ms` = 3h, overridable with code-server's
`--reconnection-grace-time`) and the extension host waits that long after "renderer disconnected".

What defeats it is the workbench explicitly saying goodbye on unload, because a graceful disconnect
bypasses the grace time altogether. In `out/server-main.js` the graceful path disposes immediately,
while an unexpected socket close schedules `this._disconnectRunner1`:

```js
V.once(this.protocol.onDidDispose)(()=>{this._log("The client has disconnected gracefully, so the connection will be disposed."),this._cleanResources()})
```

Client side, `RemoteExtensionHost.disconnect()` sends a Terminate message plus a protocol
disconnect. `$oi(2)` builds the message of type Terminate; minified names change per build and may
contain `$`:

```js
async disconnect(){this._protocol&&!this._hasDisconnected&&(this._protocol.send($oi(2)),this._protocol.sendDisconnect(),this._hasDisconnected=!0,await this._protocol.drain())}
```

## Two false trails worth recording

**The browser does not load `workbench.web.main.internal.js`.** It loads
`out/vs/code/browser/workbench/workbench.js` — its own esbuild entry point carrying a full copy of
the workbench (~17.6MB). The served HTML references
`stable-<commit>/static/out/vs/code/browser/workbench/workbench.js`. Patching
`out/vs/workbench/workbench.web.main.internal.js` changed nothing observable, and the probe
reported the patch as absent from the served bundle.

**Teardown runs on `beforeunload`, not `pagehide`.** `BrowserLifecycleService` registers both, but
it is `onBeforeUnload` that calls `doShutdown()` → `onUnload()`:

```js
this.beforeUnloadListener=$(at,se.BEFORE_UNLOAD,e=>this.onBeforeUnload(e)),this.unloadListener=$(at,se.PAGE_HIDE,()=>this.onUnload())
```

A guard latched on `pagehide` alone lost the race — the extension host still logged "received
terminate message from renderer".

## The patch

[`container-assets/patch-workbench-keepalive.mjs`](../../container-assets/patch-workbench-keepalive.mjs),
applied at **image build time** from the `Dockerfile`. Unlike the sidebar patch, the patched files
live in `/usr/lib/code-server` in the image and not in a runtime volume, so nothing can mask or
freeze the patch later. The script exits non-zero if an injection point moved, so the build fails
rather than silently shipping without the feature.

**Patch 1 — client keep-alive.** A helper prepended to the bundle latches a flag on `beforeunload`
(with `pagehide`/`unload` as belt-and-braces), clears it on `pageshow`, and self-clears after 5s so
a vetoed unload cannot leave it stuck. `disconnect()` returns early while the flag is set, so a
closed tab looks like a network drop. Explicit teardown paths such as the "Restart Extension Host"
command still send Terminate, because the flag is not set there. Escape hatch per browser profile:
set the `shim.keepExtHostAlive` localStorage key to `"false"` for stock behaviour.

**Patch 2 — reap the orphan promptly.** Reopening the window cannot re-attach (below), so it gets a
fresh extension host and the kept-alive one becomes an orphan. The server already reaps orphans via
the *short* reconnection grace time when another client connects ("Another client has connected,
will shorten the wait for reconnection ... before disposing..."), but that value is hardcoded to 5
minutes — `let s=3e5` feeding `this._reconnectionShortGraceTime=i>0?Math.min(s,i):0`. The patch
makes it read `SHIM_RECONNECT_SHORT_GRACE_MS` at runtime, default `15000`. The same constant is
patched in the extension host's own copy (`out/vs/workbench/api/node/extensionHostProcess.js`,
`Math.min(3e5,r)`), which it schedules on receiving `VSCODE_EXTHOST_IPC_REDUCE_GRACE_TIME`.

### Trade-off

If you reopen the window while the orphan is still mid-turn, the reaper cuts that turn off after
`SHIM_RECONNECT_SHORT_GRACE_MS`. Raise the env var on the container to give a long-running turn
more time to finish.

## Why a reopened tab cannot re-attach to the running extension host

The server keys connections by reconnection token. From `out/server-main.js`: with
`reconnection=true` it calls `acceptReconnection(...)` when it knows the token, else rejects with
"Unknown reconnection token (seen before)" / "(never seen)"; with `reconnection=false` and a known
token it rejects with "Duplicate reconnection token".

The token is only half the problem. `acceptReconnection` resumes a `PersistentProtocol` *mid-stream*
(`beginAcceptReconnection`/`endAcceptReconnection`, replaying unacknowledged messages). The client
half of that state — the protocol's ack counters plus the RPC layer's proxy and pending-request
state — lives in the page and dies with it, so a cold page would receive a replay it cannot
interpret. The client also mints its reconnection token per connection attempt and reuses it only
for its own reconnect loop; nothing reads it from the URL or from storage.

So the reconnection machinery covers a live page whose socket dropped (laptop sleep, network loss),
not a new page joining an existing session.

## What a reopened tab actually gets back: nothing of the window

Measured with [`_probe-window-restore.mjs`](../../mini-launcher/_probe-window-restore.mjs) and
[`_probe-window-identity.mjs`](../../mini-launcher/_probe-window-identity.mjs). Open `test.txt`,
unload, reopen, and read the editor tab labels — `["Welcome","test.txt"]` becomes `["Welcome"]`
every time:

| case | tabs after reopen |
| --- | --- |
| keep-alive patch on | `["Welcome"]` |
| keep-alive off (`shim.keepExtHostAlive="false"`) | `["Welcome"]` |
| second tab opened while the original is still alive | `["Welcome"]` |
| original killed without unload handlers (crash-like) | `["Welcome"]` |

So this is not a side effect of the patch, and there is no "duplicate the tab" trick to exploit —
a duplicated tab behaves exactly like a fresh one.

The reason is where the state lives. There is **no `state.vscdb` anywhere** in the container, not in
`workspaceStorage` and not in `globalStorage`: the workbench keeps its own state in the browser, in
IndexedDB per origin — `vscode-web-db`, `vscode-web-state-db-global`,
`vscode-web-state-db-global-shared`, plus one per workspace (`vscode-web-state-db-2e28705c-247a9`).
The per-workspace database name stayed identical across all four cases above, so the state is not
being keyed to a different window each time; a fresh page load simply starts a new window and
restores no editors, which is the same root cause as the
[workspace trust dialog reappearing every session](../troubleshooting.md#workspace-trust-dialog-reappears-every-session).

Server-side `workspaceStorage/<id>[-N]` holds only `meta.json` (`{"id","name"}`), a `vscode.lock`
(`{"pid":276,"willReleaseAt":0}`), the built-in chat's `chatSessions/` and `chatEditingSessions/`,
and per-extension per-workspace files. Each base id is one code-server start and each `-N` suffix an
additional concurrent window, which is how one project volume accumulated 23 of them.

Two consequences worth keeping in mind:

- Because the state is keyed per *origin* and the mini-launcher publishes each instance on a random
  host port that changes on every container start, whatever the browser did keep is orphaned anyway.
  A deterministic host port per project would be a precondition for any browser-side continuity —
  and for handing out a stable link.
- The Claude conversation is the part that does come back, through the existing
  [session-open bridge](mini-launcher/session-open-bridge.md) — resumed from the on-disk session
  history rather than re-attached.

The `ptyHost` process itself outlives the window (observed surviving three window open/close cycles),
so terminal *processes* are not killed. Whether a fresh window reattaches their UI was not verified —
driving the integrated terminal from Playwright proved too unreliable to measure.

## Verification

[`mini-launcher/_probe-exthost-keepalive.mjs`](../../mini-launcher/_probe-exthost-keepalive.mjs)
opens a window, waits for `.monaco-workbench`, reports whether the patch is present in the served
bundle, then navigates to `about:blank`; then it reopens a window and holds it open to watch the
orphan get reaped.

**Gotcha:** Playwright's `page.close()` tears the renderer down without letting the workbench send
its goodbye, so a *stock* build looks like a keep-alive success. Navigating away instead runs
`beforeunload` with the renderer alive, which is what a real tab close does. Always confirm the
baseline reproduces the kill before trusting a pass.

Before the patch:

```text
[21:18:10] [ManagementConnection] The client has disconnected gracefully, so the connection will be disposed.
[21:18:10] [ExtensionHostConnection] <2328> Extension Host Process exited with code: 0, signal: null.
```

After the patch — detach at 21:27:10, reopen at 21:27:15, orphan reaped at 21:27:30 (15s, not 5
minutes):

```text
[21:27:10] [172.17.0.1][265c7e52][ManagementConnection] The client has disconnected gracefully, so the connection will be disposed.
[21:27:15] [172.17.0.1][f887cd78][ExtensionHostConnection] <295> Launched Extension Host Process.
[21:27:30] [172.17.0.1][dcf2c2e1][ExtensionHostConnection] <110> Extension Host Process exited with code: 0, signal: null.
```

Noted while testing, unrelated: `docker restart` gives the container a new random host port, because
the mini-launcher creates it with an empty `HostPort`.
