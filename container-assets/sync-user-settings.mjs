// Reconciles the code-server user settings this image depends on, on every container boot.
//
// Why this is needed: /home/coder/.local/share/code-server is a per-project Docker named volume,
// and Docker seeds a named volume from image content *only the first time the volume is used*.
// The Dockerfile writes User/settings.json at build time, so any project whose volume was created
// before that line existed never received it — and without `extensions.autoUpdate: false`,
// code-server updates the Claude extension out from under the boot-time bundle patch (see
// patch-claude-sidebar.mjs). Volumes in exactly that state were found carrying two extension
// versions at once. Pairs with sync-claude-extension.sh, which reconciles the version itself.
//
// Best-effort: merges only the required keys, preserves everything else, never fails the boot.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REQUIRED_SETTINGS = {
  "security.workspace.trust.enabled": false,
  "extensions.autoUpdate": false,
  "extensions.autoCheckUpdates": false,
};

// The session broker is opt-in (SHIM_SESSION_BROKER=1). The setting has to be *removed* again when
// the flag is off, because this file lives in a persistent volume: a leftover wrapper path would
// keep the extension's permission-mode behaviour changed long after the feature was switched off.
// See container-assets/claude-broker/ and docs/plan-session-broker.md.
const BROKER_WRAPPER_KEY = "claudeCode.claudeProcessWrapper";
const BROKER_WRAPPER_PATH = "/usr/local/bin/claude-wrapper.sh";
const brokerEnabled = process.env.SHIM_SESSION_BROKER === "1";

const targetFile =
  process.env.SHIM_USER_SETTINGS_FILE ||
  path.join(os.homedir(), ".local/share/code-server/User/settings.json");

const log = (msg) => console.log(`[sync-user-settings] ${msg}`);

try {
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });

  let current = {};
  let existed = false;

  if (fs.existsSync(targetFile)) {
    existed = true;
    const raw = fs.readFileSync(targetFile, "utf8");
    if (raw.trim().length > 0) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          current = parsed;
        } else {
          log(`not a JSON object; leaving untouched: ${targetFile}`);
          process.exit(0);
        }
      } catch (err) {
        // VS Code allows comments in settings.json, which JSON.parse rejects. Rewriting from a
        // failed parse would discard real user settings, so back off instead.
        log(`unparseable JSON; leaving untouched: ${targetFile} (${err.message})`);
        process.exit(0);
      }
    }
  }

  const changedKeys = [];
  for (const [key, requiredValue] of Object.entries(REQUIRED_SETTINGS)) {
    if (current[key] !== requiredValue) {
      current[key] = requiredValue;
      changedKeys.push(key);
    }
  }

  if (brokerEnabled) {
    if (current[BROKER_WRAPPER_KEY] !== BROKER_WRAPPER_PATH) {
      current[BROKER_WRAPPER_KEY] = BROKER_WRAPPER_PATH;
      changedKeys.push(BROKER_WRAPPER_KEY);
    }
  } else if (current[BROKER_WRAPPER_KEY] === BROKER_WRAPPER_PATH) {
    delete current[BROKER_WRAPPER_KEY];
    changedKeys.push(`-${BROKER_WRAPPER_KEY}`);
  }

  if (changedKeys.length === 0) {
    log("already correct");
    process.exit(0);
  }

  fs.writeFileSync(targetFile, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  if (!existed) log(`created ${targetFile}`);
  log(`applied: ${changedKeys.join(", ")}`);
} catch (err) {
  log(`failed: ${err?.message || String(err)}`);
}
