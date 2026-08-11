// Client-safe pinned target configuration.
// This file must NOT import Node.js builtins — it is used by client components.

export const PINNED_HOST_PATH = "C:\\work\\git\\cveld\\vscode-claude-shim\\vscode-simulator";
export const CLAUDE_EXTENSION_WEBVIEW_ROOT = "C:\\Users\\CarlintVeld\\.vscode\\extensions\\anthropic.claude-code-2.1.209-win32-x64\\webview";
export const CLAUDE_EXTENSION_WEBVIEW_ENTRY = "index.js";
export const CLAUDE_EXTENSION_WEBVIEW_STYLE = "index.css";

/** Human-readable label for the pinned folder (last path segment). */
export function pinnedLabel(): string {
  const segments = PINNED_HOST_PATH.split("\\").filter(Boolean);
  return segments[segments.length - 1] ?? "vscode-simulator";
}

/** Human-readable label for the configured Claude extension install. */
export function extensionLabel(): string {
  const segments = CLAUDE_EXTENSION_WEBVIEW_ROOT.split("\\").filter(Boolean);
  return segments[segments.length - 2] ?? "anthropic.claude-code";
}
