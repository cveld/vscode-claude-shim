# RE: surviving an extension-host restart by owning the CLI process

Measured against Claude Code extension **2.1.226** and CLI 2.1.x in a live container
(`shim-experiments-*`, code-server 4.131.0).

## The problem this is about

Closing the browser tab no longer kills the extension host outright — the
[keep-alive patch](exthost-keepalive.md) turns a graceful goodbye into a network drop. But
reopening the tab always creates a *new* extension host, and the kept-alive one is then reaped as
an orphan. So a Claude turn that was running when the tab closed still dies, just later. And a
reopened tab can never re-attach to the old one; that is a hard property of code-server's
reconnection machinery, [proven separately](exthost-keepalive.md#why-a-reopened-tab-cannot-re-attach-to-the-running-extension-host).

## Why "run the real extension out of process and proxy to it" cannot work

The intuition — a thin proxy extension that reconnects to a long-lived *real* extension instance —
does not survive contact with the extension model:

- A VS Code extension is not a process. It is a module the extension host loads and hands a live
  `vscode` API object (editors, commands, webviews, workspace events). Outside an extension host
  there is nothing for those calls to bind to.
- The Claude extension's UI is a **webview**, so it lives in the browser page and dies with the
  tab no matter where the extension code runs. See
  [vscode-simulator/ui-packaging.md](vscode-simulator/ui-packaging.md).

The useful split is one layer lower.

## The seam: the CLI child process

The extension bundles `@anthropic-ai/claude-agent-sdk`, which spawns the CLI and speaks
newline-delimited JSON to it over pipes. From `extension.js`, `spawnLocalProcess`:

```js
spawnLocalProcess(e){let{command:t,args:r,cwd:n,env:i,signal:o}=e,
  s=nse.spawn(t,r,{cwd:n,stdio:["pipe","pipe","pipe"],signal:o,env:i,windowsHide:!0})
```

and the argv the SDK builds:

```js
let G=["--output-format","stream-json","--verbose","--input-format","stream-json"]
```

So the extension is UI plus glue, and the process that actually carries a running turn is an
ordinary child with three pipes. That child is what has to outlive the extension host — and a
child's lifetime is a matter of who its parent is, which is something we can change.

## The lever: `claudeCode.claudeProcessWrapper`

The extension ships a first-class setting for exactly this interposition. From `package.json`:

```json
"claudeCode.claudeProcessWrapper": {
  "type": "string",
  "scope": "machine",
  "description": "Executable path used to launch the Claude process."
}
```

Read through `bn`, i.e. from the **`claudeCode`** configuration section (not `claude-code`, which
the same bundle also uses for a couple of unrelated keys):

```js
function bn(e){return Hi.workspace.getConfiguration("claudeCode").get(e)}
```

`resolveClaudeBinary()` turns it into the SDK's `pathToClaudeCodeExecutable`, pushing the real
command down into `executableArgs`:

```js
resolveClaudeBinary(){let e=bn("claudeProcessWrapper"),t=$p(_o.resolveShellPath(this.output)),r,n;
  if(r=D6t(this.context),!r){let i=this.context.asAbsolutePath(On.join("resources","claude-code","cli.js"));
    if(ki.existsSync(i))L6t(process.execPath),n=process.execPath,r=i}
  if(e)return{pathToClaudeCodeExecutable:e,executableArgs:r?n?[n,r]:[r]:[],env:t};
```

and `Hc()` assembles the final argv, wrapper first:

```js
function Hc(e,t=[]){let{pathToClaudeCodeExecutable:r,executableArgs:n,nodePath:i}=e;
  if(n.length>0)return{command:r,args:[...n,...t]};
  if(i)return{command:i,args:[r,...t]};
  return{command:r,args:t}}
```

**No bundle patch is needed for this** — unlike the side-bar resume feature, which had to rewrite
`extension.js` ([session-open-bridge.md](mini-launcher/session-open-bridge.md)).

## What the wrapper actually receives (measured)

Probe: [`mini-launcher/_probe-process-wrapper.mjs`](../../mini-launcher/_probe-process-wrapper.mjs)
opens a window and holds it; a shell wrapper logged its argv and `exec "$@"`-ed through, so the
extension kept working while being observed. A session-open signal
([the bridge](mini-launcher/session-open-bridge.md)) was written first, so the extension resumed a
real session rather than only running its startup calls.

Two invocations were logged. The startup auth probe:

```text
argv[1]=…/extensions/anthropic.claude-code-2.1.226/resources/native-binary/claude
argv[2]=auth  argv[3]=status  argv[4]=--json
```

and, three seconds later, the query that matters:

```text
argv[1]=…/resources/native-binary/claude
--output-format stream-json --verbose --input-format stream-json
--max-thinking-tokens 31999
--permission-prompt-tool stdio
--resume=5148e9f2-12d5-4a47-a79a-2b4e17906010
--setting-sources=user,project,local
--permission-mode default
--debug --debug-to-stderr --enable-auth-status --no-chrome
--replay-user-messages
```

with `cwd=/home/coder/project`, `CLAUDE_CODE_ENTRYPOINT=claude-vscode`, and the parent being the
extension host itself:

```text
ppid 1107 → /usr/lib/code-server/lib/node … bootstrap-fork --type=extensionHost …
```

`ps` reported the CLI as `pgid=37 sess=37` — the same process group and session as code-server
(pid 37). It is not in a group of its own, so it is only the parent relationship (and stdin
closing) that ties its life to the extension host.

### Five consequences that shape the design

1. **`--resume=<id>` arrives on the command line.** The wrapper gets the session key handed to it
   before the process even starts, so a broker can decide "new or existing" without parsing the
   stream. A *fresh* conversation has no `--resume`; there the id arrives in the `system/init`
   frame on stdout instead, so both cases are keyable.
2. **`--permission-prompt-tool stdio`** — permission prompts travel over the same stdio stream. A
   broker can therefore park a prompt raised while no UI is attached and re-offer it on reattach,
   in band, with no second channel.
3. **`--replay-user-messages`** — the CLI already echoes user messages back on the stream, which
   is useful for rebuilding a transcript on reattach.
4. **`--debug --debug-to-stderr`** keeps debug chatter off stdout, so stdout stays clean NDJSON and
   stderr can be treated as opaque text.
5. **`argv[1]` is always a real executable.** Here it resolved to the bundled
   `resources/native-binary/claude`, so `executableArgs = [binary]` with no `nodePath`. The
   `[node, cli.js]` shape in `resolveClaudeBinary()` does not occur in this image, so a plain
   `exec "$@"` passthrough is sufficient. Worth re-checking after a `CLAUDE_VERSION` bump.

### Side effect to keep in mind

Setting the wrapper changes permission handling. The extension passes:

```js
resolvePermissionModeInCli: !bn("claudeProcessWrapper")
```

so with a wrapper configured the extension resolves the permission mode itself instead of letting
the CLI do it. It also suppresses a one-off `permissionModeCleared20260804` migration. Neither is
obviously harmful, but this is the one place where merely *setting* the wrapper changes behaviour
beyond process ancestry.

## Adjacent: the CLI already has detached sessions

The CLI exposes `--bg`/`--background` ("Start the session as a background agent and return
immediately") plus `claude agents [--json]` to list and manage active interactive *and* background
sessions. That is a supported detached-session primitive, but the extension does not use it — it
drives its own SDK query — so it does not help the "tab closed mid-turn" case. It is interesting
for the mini-launcher as a separate route: start sessions outside code-server and use the
extension purely as a viewer.

## What is not proven yet

- That a reattaching client can complete the SDK's `initialize` handshake against a CLI that is
  already mid-turn. This is the real remaining risk; the control protocol carries request/response
  ids, so a broker must be protocol-aware rather than a byte pipe.
- Process survival itself was not measured, but it is not in doubt: a child in its own session
  (`setsid`) does not die with an unrelated process. The constraint that *does* matter is that
  something must keep draining stdout and holding stdin open, or the CLI blocks on a full pipe or
  exits on EOF.

## Noted while testing, unrelated

`extensions.autoUpdate` in the container's user settings had become the string `"off"`, while
[`sync-user-settings.mjs`](../../container-assets/sync-user-settings.mjs) compares against the
boolean `false`. VS Code migrated the boolean to its newer string enum, so that key is rewritten
on every boot and re-migrated by VS Code afterwards. Harmless churn, but the sync should accept
both.
