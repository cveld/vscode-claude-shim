// Client-safe pinned target configuration.
// This file must NOT import Node.js builtins — it is used by client components.
// Server-only resolution logic (roots, paths) lives in the API routes and
// lib/sessions.ts.

export const PINNED_HOST_PATH = "C:\\work\\git\\github\\cveld\\Experiments\\2026-07 vscode shim tester";
export const PINNED_DISPLAY_PATH = "C:\\work\\git\\github\\cveld\\Experiments\\2026-07 vscode shim tester";

/** Human-readable label for the pinned folder (last path segment). */
export function pinnedLabel(): string {
  const segments = PINNED_DISPLAY_PATH.split("\\").filter(Boolean);
  return segments[segments.length - 1];
}