// Generates the container's ~/.claude/settings.json by merging launcher/shim-settings.json
// with a fixed safety default.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SHIM_SETTINGS_PATH = path.resolve(process.cwd(), "../launcher/shim-settings.json");
const SETTINGS_TMP_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "vscode-shim");
const SETTINGS_TMP_FILE = path.join(SETTINGS_TMP_DIR, "container-settings.json");
const FORCED_SETTINGS = { autoInstallIdeExtension: false };

export function readShimSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(SHIM_SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function buildContainerSettingsFile(): string {
  const merged = { ...readShimSettings(), ...FORCED_SETTINGS };
  fs.mkdirSync(SETTINGS_TMP_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_TMP_FILE, JSON.stringify(merged, null, 2));
  return SETTINGS_TMP_FILE;
}
