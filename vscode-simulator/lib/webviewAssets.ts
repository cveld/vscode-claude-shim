import fs from "node:fs";
import path from "node:path";
import { CLAUDE_EXTENSION_WEBVIEW_ENTRY, CLAUDE_EXTENSION_WEBVIEW_STYLE } from "@/simulator-lib/config";
import { getExtensionResourcesRoot, getExtensionWebviewRoot } from "@/simulator-lib/extensionPaths";

type WebviewAssetInfo = {
  assetRoot: string;
  entryScript: string;
  entryStyle: string;
  entryScriptPath: string;
  entryStylePath: string;
};

function normalizeRoot(root: string): string {
  return path.win32.resolve(root);
}

function assertInsideRoot(root: string, candidate: string): string {
  const normalizedRoot = normalizeRoot(root);
  const resolved = path.win32.resolve(normalizedRoot, candidate);
  const relative = path.win32.relative(normalizedRoot, resolved);
  if (relative.startsWith("..") || path.win32.isAbsolute(relative)) {
    throw new Error("Requested asset path escapes the configured webview root");
  }
  return resolved;
}

export function getWebviewAssetInfo(): WebviewAssetInfo {
  const assetRoot = normalizeRoot(getExtensionWebviewRoot());
  const entryScriptPath = assertInsideRoot(assetRoot, CLAUDE_EXTENSION_WEBVIEW_ENTRY);
  const entryStylePath = assertInsideRoot(assetRoot, CLAUDE_EXTENSION_WEBVIEW_STYLE);

  if (!fs.existsSync(assetRoot)) {
    throw new Error("Configured Claude extension webview root does not exist on host");
  }
  if (!fs.existsSync(entryScriptPath)) {
    throw new Error(`Configured webview entry script is missing: ${CLAUDE_EXTENSION_WEBVIEW_ENTRY}`);
  }
  if (!fs.existsSync(entryStylePath)) {
    throw new Error(`Configured webview stylesheet is missing: ${CLAUDE_EXTENSION_WEBVIEW_STYLE}`);
  }

  return {
    assetRoot,
    entryScript: CLAUDE_EXTENSION_WEBVIEW_ENTRY,
    entryStyle: CLAUDE_EXTENSION_WEBVIEW_STYLE,
    entryScriptPath,
    entryStylePath,
  };
}

export function resolveWebviewAssetPath(relativePath: string): string {
  return assertInsideRoot(getExtensionWebviewRoot(), relativePath);
}

// Root-bounded resolution for the extension's resources/ dir (icons/logos the webview requests
// via asset_uris_response, rewritten to the /resources/ prefix by the facade's asWebviewUri).
export function resolveExtensionResourcePath(relativePath: string): string {
  return assertInsideRoot(getExtensionResourcesRoot(), relativePath);
}
