import fs from "node:fs";
import path from "node:path";

// Single source of truth for locating the installed Claude Code extension on this host.
// The extension auto-updates (2.1.209 → 2.1.210 → … → 2.1.212 and beyond), so the install
// directory version changes underfoot. Everything that needs the extension on disk — the
// host shim (extension.js) and the webview asset server (webview/*) — resolves through here
// instead of hard-coding a version that goes stale on the next update.
//
// Server-only: imports node:fs. Do NOT import from client components.

const EXTENSIONS_DIR = "C:\\Users\\CarlintVeld\\.vscode\\extensions";
const EXTENSION_DIR_PREFIX = "anthropic.claude-code-";
const FALLBACK_VERSION = "2.1.209";

export function resolveExtensionRoot(): string {
  const fallback = path.join(EXTENSIONS_DIR, `${EXTENSION_DIR_PREFIX}${FALLBACK_VERSION}-win32-x64`);
  let entries: string[];
  try {
    entries = fs.readdirSync(EXTENSIONS_DIR);
  } catch {
    return fallback;
  }
  const candidates = entries
    .filter((name) => name.startsWith(EXTENSION_DIR_PREFIX))
    .map((name) => ({ name, version: parseExtensionVersion(name) }))
    .filter((entry) => fs.existsSync(path.join(EXTENSIONS_DIR, entry.name, "extension.js")))
    .sort((a, b) => compareVersions(b.version, a.version));
  return candidates.length > 0 ? path.join(EXTENSIONS_DIR, candidates[0].name) : fallback;
}

export function getExtensionWebviewRoot(): string {
  return path.join(resolveExtensionRoot(), "webview");
}

export function getExtensionResourcesRoot(): string {
  return path.join(resolveExtensionRoot(), "resources");
}

// Directory-name label for the resolved install, e.g. "anthropic.claude-code-2.1.212-win32-x64".
export function getExtensionLabel(): string {
  return path.basename(resolveExtensionRoot());
}

function parseExtensionVersion(dirName: string): number[] {
  const match = dirName.slice(EXTENSION_DIR_PREFIX.length).match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
