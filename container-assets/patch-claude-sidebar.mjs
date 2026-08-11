// Patches the shipped Anthropic Claude Code extension so a specific historic session can be
// resumed *in the side bar* (not just an editor panel).
//
// Why this is needed: the extension exposes no command that opens a chosen session in the side
// bar — `editor.open`/`primaryEditor.open` force an editor panel, `sidebar.open` opens a fresh
// conversation. But the side bar view builds its HTML via `getHtmlForWebview(webview, session,
// …)` with the session arg hard-coded to `void 0`. The webview reads that as
// `data-initial-session` and resumes it — exactly how editor panels resume. So we inject the
// session id there.
//
// How it decides which session: it reads the mini-launcher's signal file
// (~/.claude/.shim-open-session) at HTML-build time. If a *fresh* signal (< 2 min old) has
// `target: "sidebar"` and a `sessionId`, that id is injected. Freshness avoids hijacking normal
// side bar usage with a stale signal. See docs/re/mini-launcher/session-open-bridge.md.
//
// Runs at container startup (idempotent) — the extension lives in a runtime volume, so a
// build-time patch would be either masked or frozen to one version. Re-running each boot also
// re-applies the patch after an extension update.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MARKER = "__shimSidebarSession";

// A global helper the patched call site invokes. Reads the launcher's signal file and returns a
// session id only for a fresh sidebar-targeted signal; otherwise undefined (→ fresh conversation).
const HELPER =
  "globalThis." + MARKER + "=function(){try{var o=require('os'),f=require('fs')," +
  "p=(process.env.SHIM_OPEN_SESSION_FILE||(o.homedir()+'/.claude/.shim-open-session'))," +
  "j=JSON.parse(f.readFileSync(p,'utf8'));" +
  "if(j&&j.target==='sidebar'&&typeof j.sessionId==='string'&&j.sessionId&&" +
  "typeof j.ts==='number'&&(Date.now()-j.ts)<120000)return j.sessionId;}catch(e){}return undefined;};";

// Only the side bar view uses the 4-arg `(webview, void 0, void 0, !0)` form. The sessions list
// is 6-arg (`…,!1,!1,!0`) and editor panels pass a real session — neither matches.
const CALL_RE = /(getHtmlForWebview\(\w+\.webview,)void 0(,void 0,!0\))/;

function extensionsDir() {
  return (
    process.env.SHIM_EXTENSIONS_DIR ||
    path.join(os.homedir(), ".local", "share", "code-server", "extensions")
  );
}

function findExtensionFiles() {
  const dir = extensionsDir();
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.toLowerCase().startsWith("anthropic.claude-code-"))
    .map((name) => path.join(dir, name, "extension.js"))
    .filter((file) => fs.existsSync(file));
}

function patchFile(file) {
  const src = fs.readFileSync(file, "utf8");
  if (src.includes(MARKER)) {
    console.log(`[patch-claude-sidebar] already patched: ${file}`);
    return true;
  }
  if (!CALL_RE.test(src)) {
    console.log(`[patch-claude-sidebar] injection point not found (extension changed?): ${file}`);
    return false;
  }
  const patched =
    HELPER + "\n" + src.replace(CALL_RE, `$1globalThis.${MARKER}()$2`);
  fs.writeFileSync(file, patched, "utf8");
  console.log(`[patch-claude-sidebar] patched: ${file}`);
  return true;
}

const files = findExtensionFiles();
if (files.length === 0) {
  console.log("[patch-claude-sidebar] no Anthropic Claude Code extension found; nothing to do.");
} else {
  for (const file of files) {
    try {
      patchFile(file);
    } catch (err) {
      console.log(`[patch-claude-sidebar] failed to patch ${file}: ${err && err.message}`);
    }
  }
}
