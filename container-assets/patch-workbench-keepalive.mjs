// Keeps the VS Code extension host — and with it a running Claude session — alive when the
// browser window closes.
//
// The problem: closing the tab does NOT stop the container (code-server keeps running), but the
// web workbench tears the extension host down on page unload, so any in-flight Claude turn dies
// within ~3 seconds:
//
//   [ManagementConnection] The client has disconnected gracefully, so the connection will be disposed.
//   [ExtensionHostConnection] <940> Extension Host Process exited with code: 0, signal: null.
//
// Both halves of the server are already built for surviving a *dropped* client: the extension
// host receives VSCODE_RECONNECTION_GRACE_TIME (default 3h, see code-server's
// --reconnection-grace-time) and waits that long after "renderer disconnected". What defeats it
// is the workbench explicitly saying goodbye on unload — `RemoteExtensionHost.disconnect()`
// sends a `Terminate` message plus a protocol-level disconnect, and the extension host treats
// either as "exit now" (`onDidDispose` -> "renderer disconnected"), skipping the grace time.
//
// So patch 1 suppresses that goodbye *while the page is unloading only*. A closed tab then looks
// like a network drop, and the extension host keeps working. Explicit teardown paths (the
// "Restart Extension Host" command, extension host shutdown from within VS Code) still send
// Terminate normally, because the unload flag is not set there.
//
// Patch 2 deals with the flip side. Reopening the window cannot re-attach to the old extension
// host: the server keys connections by reconnection token, and a fresh page has neither the token
// nor the client-side protocol state that `acceptReconnection` resumes — it gets a brand-new
// extension host. The orphan is then reaped by the server's *short* reconnection grace time,
// which is hardcoded to 5 minutes ("Another client has connected, will shorten the wait..."), so
// a redundant extension host would linger that long. Patch 2 makes that value configurable and
// defaults it to 15s, so the orphan is dropped shortly after the new window is up. Raise it via
// SHIM_RECONNECT_SHORT_GRACE_MS on the container if you want a turn that is still running in the
// orphan to get more time to finish.
//
// Unlike patch-claude-sidebar.mjs this runs at *build* time: these files live in
// /usr/lib/code-server (baked into the image, root-owned), not in a runtime volume, so there is
// nothing that could mask or freeze the patch later. Every step is idempotent and best-effort.
//
// Verify with mini-launcher/_probe-exthost-keepalive.mjs.

import fs from "node:fs";
import path from "node:path";

const VSCODE_OUT =
  process.env.SHIM_VSCODE_OUT || "/usr/lib/code-server/lib/vscode/out";

const KEEPALIVE_MARKER = "__shimKeepExtHostAlive";
const GRACE_MARKER = "SHIM_RECONNECT_SHORT_GRACE_MS";
const DEFAULT_SHORT_GRACE_MS = 15000;

// Runtime-read override, injected into the two server-side bundles (Node, so process.env works).
const SHORT_GRACE_EXPR =
  `(Number(process.env.${GRACE_MARKER})>0?Number(process.env.${GRACE_MARKER}):${DEFAULT_SHORT_GRACE_MS})`;

// Browser side has no env, so the escape hatch is localStorage: setting
// `shim.keepExtHostAlive` to "false" restores stock behaviour for that browser profile.
//
// The flag has to be latched on `beforeunload`, not `pagehide`: BrowserLifecycleService registers
// both, and it is `onBeforeUnload` that calls `doShutdown()` -> `onUnload()` -> willShutdown ->
// extension host teardown. Latching on `pagehide` alone measurably lost the race — the extension
// host still logged "received terminate message from renderer". `pagehide`/`unload` stay as
// belt-and-braces for paths that skip beforeunload.
//
// Registered at bundle top level, i.e. before the workbench's own listeners, so ours latches
// first. `beforeunload` can be vetoed (VS Code prompts on unsaved work), which would otherwise
// leave the flag stuck on a page that lives on, so it self-clears shortly after and on `pageshow`.
const KEEPALIVE_HELPER =
  "globalThis." + KEEPALIVE_MARKER + "=(function(){var u=false,t=null;" +
  "function latch(){u=true;if(t)clearTimeout(t);t=setTimeout(function(){u=false},5000)}" +
  "try{if(typeof addEventListener==='function'){" +
  "addEventListener('beforeunload',latch,{capture:true});" +
  "addEventListener('pagehide',latch,{capture:true});" +
  "addEventListener('unload',latch,{capture:true});" +
  "addEventListener('pageshow',function(){u=false},{capture:true});" +
  "}}catch(e){}return function(){" +
  "try{if(localStorage.getItem('shim.keepExtHostAlive')==='false')return false}catch(e){}" +
  "return u}})();";

// `async disconnect(){this._protocol&&!this._hasDisconnected&&(this._protocol.send(<mkMsg>(2)),
//  this._protocol.sendDisconnect(),...)}` on RemoteExtensionHost. `<mkMsg>(2)` builds a message
// of type Terminate; minified names change per build and may contain `$`, hence [\w$]+.
const CLIENT_RE =
  /async disconnect\(\)\{(this\._protocol&&!this\._hasDisconnected&&\(this\._protocol\.send\([\w$]+\(2\)\),this\._protocol\.sendDisconnect\(\))/;

// AbstractConnection's constructor: `this._reconnectionGraceTime=<arg>;let <s>=3e5;` feeding
// `this._reconnectionShortGraceTime=<arg>>0?Math.min(<s>,<arg>):0`.
const SERVER_RE = /(this\._reconnectionGraceTime=[\w$]+;let [\w$]+=)3e5;/;

// Extension host side of the same shortening, triggered by VSCODE_EXTHOST_IPC_REDUCE_GRACE_TIME:
// `<r>=kee("VSCODE_RECONNECTION_GRACE_TIME",108e5),<s>=<r>>0?Math.min(3e5,<r>):0`.
const EXTHOST_RE = /(=[\w$]+>0\?Math\.min\()3e5(,[\w$]+\):0)/;

// The browser gets `vs/code/browser/workbench/workbench.js` — its own esbuild entry point, which
// carries a full copy of the workbench. `vs/workbench/workbench.web.main.internal.js` holds the
// same code but is not what the page loads (verified against the served HTML), so it is patched
// only opportunistically, in case a future code-server version switches entry points.
const CLIENT_FILES = [
  path.join(VSCODE_OUT, "vs", "code", "browser", "workbench", "workbench.js"),
  path.join(VSCODE_OUT, "vs", "workbench", "workbench.web.main.internal.js"),
];

const clientTargets = CLIENT_FILES.map((file, index) => ({
  label: `workbench keep-alive (${path.basename(file)})`,
  file,
  marker: KEEPALIVE_MARKER,
  re: CLIENT_RE,
  optional: index > 0,
  apply: (src) =>
    KEEPALIVE_HELPER +
    "\n" +
    src.replace(
      CLIENT_RE,
      `async disconnect(){if(globalThis.${KEEPALIVE_MARKER}&&globalThis.${KEEPALIVE_MARKER}())return;$1`,
    ),
}));

const targets = [
  ...clientTargets,
  {
    label: "server short grace time",
    file: path.join(VSCODE_OUT, "server-main.js"),
    marker: GRACE_MARKER,
    re: SERVER_RE,
    apply: (src) => src.replace(SERVER_RE, `$1${SHORT_GRACE_EXPR};`),
  },
  {
    label: "extension host short grace time",
    file: path.join(VSCODE_OUT, "vs", "workbench", "api", "node", "extensionHostProcess.js"),
    marker: GRACE_MARKER,
    re: EXTHOST_RE,
    apply: (src) => src.replace(EXTHOST_RE, `$1${SHORT_GRACE_EXPR}$2`),
  },
];

let failed = 0;
for (const target of targets) {
  try {
    if (!fs.existsSync(target.file)) {
      console.log(`[patch-workbench-keepalive] missing, skipped: ${target.file}`);
      if (!target.optional) failed++;
      continue;
    }
    const src = fs.readFileSync(target.file, "utf8");
    if (src.includes(target.marker)) {
      console.log(`[patch-workbench-keepalive] already patched (${target.label})`);
      continue;
    }
    if (!target.re.test(src)) {
      console.log(
        `[patch-workbench-keepalive] injection point not found (${target.label}) — code-server changed?`,
      );
      if (!target.optional) failed++;
      continue;
    }
    fs.writeFileSync(target.file, target.apply(src), "utf8");
    console.log(`[patch-workbench-keepalive] patched (${target.label})`);
  } catch (err) {
    console.log(
      `[patch-workbench-keepalive] failed to patch ${target.file}: ${err && err.message}`,
    );
    failed++;
  }
}

if (failed > 0) {
  // Fail the image build rather than shipping a silently missing feature: a stock code-server
  // still *works*, it just kills the extension host on window close, which is exactly the bug
  // this patch exists for. A red build says "code-server moved, re-derive the injection points".
  console.log(
    `[patch-workbench-keepalive] ${failed} of ${targets.length} patches not applied — closing the browser window would still kill the extension host.`,
  );
  process.exitCode = 1;
}
