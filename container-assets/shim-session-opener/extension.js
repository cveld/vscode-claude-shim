// Shim Session Opener
//
// Headless code-server cannot deep-link into an extension's chat panel via a URL
// (the vscode:// URI handler only works on desktop; code-server's URL-callback path
// only fires for round-trips the workbench itself started). So the mini-launcher
// signals what it wants by writing a small JSON file into the container, and this
// extension runs the matching Claude command for it.
//
// Signal file (default ~/.claude/.shim-open-session), written by the launcher:
//   { "sessionId": "<uuid>", "ts": <epoch-ms>, "target": "editor" | "sidebar" }
// The `ts` acts as a nonce so re-clicking the same thing still triggers an action.
//
// target:
//   "editor" (default) — resume the given session in a full editor panel. Verified
//                        path: claude-vscode.primaryEditor.open <sessionId>.
//   "sidebar"          — reveal Claude in the side bar (claude-vscode.sidebar.open). If the
//                        signal carries a sessionId, that session resumes *in the side bar* —
//                        but only because the shipped extension is patched at container startup
//                        to read this signal file when it builds the side bar webview
//                        (patch-claude-sidebar.mjs). Without that patch the side bar always opens
//                        a fresh conversation. This extension's job for "sidebar" is just to
//                        reveal the view so the patched build path runs. See
//                        docs/re/mini-launcher/session-open-bridge.md.

const vscode = require("vscode");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const OPEN_COMMANDS = ["claude-vscode.primaryEditor.open", "claude-vscode.editor.open"];
const SIDEBAR_COMMANDS = ["claude-vscode.sidebar.open"];
const COMMAND_WAIT_TRIES = 60; // ~30s at 500ms
const COMMAND_WAIT_INTERVAL_MS = 500;

function signalFilePath() {
  return (
    process.env.SHIM_OPEN_SESSION_FILE ||
    path.join(os.homedir(), ".claude", ".shim-open-session")
  );
}

/** @param {vscode.OutputChannel} out */
function readSignal(out) {
  const file = signalFilePath();
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null; // no signal yet
  }
  try {
    const parsed = JSON.parse(raw);
    const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId.trim() : "";
    const target = parsed.target === "sidebar" ? "sidebar" : "editor";
    // A sidebar action needs no session; an editor action does.
    if (target === "editor" && !sessionId) return null;
    const ts = Number.isFinite(parsed.ts) ? parsed.ts : 0;
    return { sessionId, ts, target };
  } catch (err) {
    out.appendLine(`ignored malformed signal file: ${err && err.message}`);
    return null;
  }
}

/** Resolve the first available command from `candidates`, waiting for registration. */
async function resolveCommand(candidates) {
  for (let i = 0; i < COMMAND_WAIT_TRIES; i++) {
    const cmds = await vscode.commands.getCommands(true);
    const found = candidates.find((c) => cmds.includes(c));
    if (found) return found;
    await new Promise((r) => setTimeout(r, COMMAND_WAIT_INTERVAL_MS));
  }
  return null;
}

async function activate(context) {
  const out = vscode.window.createOutputChannel("Shim Session Opener");
  context.subscriptions.push(out);

  let lastHandledTs = -1;
  let running = false;

  async function actOnSignal(reason) {
    const signal = readSignal(out);
    if (!signal) return;
    if (signal.ts <= lastHandledTs) return; // already handled this (or older) request
    if (running) return;
    running = true;
    try {
      if (signal.target === "sidebar") {
        const command = await resolveCommand(SIDEBAR_COMMANDS);
        if (!command) {
          out.appendLine("Claude sidebar command not available; giving up for now.");
          return;
        }
        if (signal.sessionId) {
          out.appendLine(
            `[${reason}] revealing the side bar for session ${signal.sessionId} ` +
              `(the patched build path injects it as the initial session)`,
          );
        } else {
          out.appendLine(`[${reason}] docking Claude in the side bar via ${command}`);
        }
        await vscode.commands.executeCommand(command);
      } else {
        const command = await resolveCommand(OPEN_COMMANDS);
        if (!command) {
          out.appendLine("Claude open-session command not available; giving up for now.");
          return;
        }
        out.appendLine(`[${reason}] opening session ${signal.sessionId} via ${command}`);
        await vscode.commands.executeCommand(command, signal.sessionId);
      }
      lastHandledTs = signal.ts;
    } catch (err) {
      out.appendLine(`failed to act on signal: ${err && err.message}`);
    } finally {
      running = false;
    }
  }

  // 1) A fresh window: honour whatever the launcher last asked for.
  void actOnSignal("startup");

  // 2) A live window: react when the launcher rewrites the signal file.
  const dir = path.dirname(signalFilePath());
  const base = path.basename(signalFilePath());
  try {
    const watcher = fs.watch(dir, (_event, filename) => {
      if (!filename || filename === base) void actOnSignal("watch");
    });
    context.subscriptions.push({ dispose: () => watcher.close() });
  } catch (err) {
    out.appendLine(`could not watch signal dir (${dir}): ${err && err.message}`);
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
