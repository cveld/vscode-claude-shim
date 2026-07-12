// GET /api/browse: lazy drill-down directory listing (docs/plan-launcher-daemon.md, decision
// 7) — one readdir per call, no recursive pre-scan.

import fs from 'node:fs';
import path from 'node:path';
import { resolveRoot, type Root } from './paths.js';

export interface BrowseEntry {
  name: string;
  type: 'folder' | 'workspace';
}

export interface BrowseResult {
  rootId: string;
  relativePath: string;
  children: BrowseEntry[];
}

// Lists the immediate children (subfolders + *.code-workspace files) of `relativePath` inside
// root `rootId`. Returns `null` if the root is unknown or the resolved path escapes the root
// (defensive re-check against `..` reaching this API param directly).
export function browse(roots: Root[], rootId: string, relativePath = ''): BrowseResult | null {
  const root = roots.find((r) => r.id === rootId);
  if (!root) return null;

  const segments = relativePath.split('/').filter(Boolean);
  const absPath = path.win32.resolve(root.hostPath, ...segments);
  const match = resolveRoot(roots, absPath);
  if (!match || match.root.id !== rootId) return null;

  const entries = fs.readdirSync(absPath, { withFileTypes: true });
  const children: BrowseEntry[] = entries
    .filter((entry) => entry.isDirectory() || entry.name.toLowerCase().endsWith('.code-workspace'))
    .map((entry): BrowseEntry => ({
      name: entry.name,
      type: entry.isDirectory() ? 'folder' : 'workspace',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { rootId, relativePath: match.relativePath, children };
}

// Windows-reserved filename characters, plus `/` since it would otherwise be read as a nested
// path segment.
const FORBIDDEN_NAME_CHARS = /[\\/:*?"<>|]/;

export interface CreateFolderResult {
  rootId: string;
  relativePath: string;
  name: string;
}

// Creates a new subfolder named `name` inside `relativePath` of root `rootId`. Returns `null`
// under the same "unknown root or path escapes the root" conditions as `browse`. Throws on an
// invalid name or a name that already exists, so callers can surface a 400 vs. a 404.
export function createFolder(
  roots: Root[],
  rootId: string,
  relativePath: string,
  name: string,
): CreateFolderResult | null {
  if (!name || FORBIDDEN_NAME_CHARS.test(name) || name === '.' || name === '..') {
    throw new Error('invalid folder name');
  }

  const root = roots.find((r) => r.id === rootId);
  if (!root) return null;

  const segments = relativePath.split('/').filter(Boolean);
  const parentAbsPath = path.win32.resolve(root.hostPath, ...segments);
  const parentMatch = resolveRoot(roots, parentAbsPath);
  if (!parentMatch || parentMatch.root.id !== rootId) return null;

  const newAbsPath = path.win32.join(parentAbsPath, name);
  if (fs.existsSync(newAbsPath)) {
    throw new Error('a file or folder with that name already exists');
  }

  fs.mkdirSync(newAbsPath);
  const newRelativePath = parentMatch.relativePath ? `${parentMatch.relativePath}/${name}` : name;
  return { rootId, relativePath: newRelativePath, name };
}