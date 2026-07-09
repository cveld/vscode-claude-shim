// Generates the container's `~/.claude/settings.json` by merging `daemon/shim-settings.json`
// (host-editable via the launcher's Settings panel, docs/plan-launcher-daemon.md decision 9
// addendum) with a fixed, non-overridable safety default. Regenerated on every container
// launch — same "host original stays the source of truth" pattern as lib/workspace.js — so
// edits made through the launcher take effect on the next launch without an image rebuild.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SHIM_SETTINGS_PATH = path.join(__dirname, '..', 'shim-settings.json');

const SETTINGS_TMP_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'vscode-shim');
const SETTINGS_TMP_FILE = path.join(SETTINGS_TMP_DIR, 'container-settings.json');

// code-server has no `code` binary, so the CLI's auto-install-companion-extension feature
// can't work here (see Dockerfile / docs/troubleshooting.md). Applied after the spread so no
// key in the user-edited file can turn it back on.
const FORCED_SETTINGS = { autoInstallIdeExtension: false };

export function readShimSettings() {
  try {
    return JSON.parse(fs.readFileSync(SHIM_SETTINGS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function writeShimSettings(settings) {
  fs.writeFileSync(SHIM_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

// Not per-instance: the merged content is identical for every container at a given point in
// time, so one shared temp file is enough (unlike lib/workspace.js, which is per-workspace).
// Returns the host path to bind-mount read-only onto /home/coder/.claude/settings.json.
export function buildContainerSettingsFile() {
  const merged = { ...readShimSettings(), ...FORCED_SETTINGS };
  fs.mkdirSync(SETTINGS_TMP_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_TMP_FILE, JSON.stringify(merged, null, 2));
  return SETTINGS_TMP_FILE;
}
