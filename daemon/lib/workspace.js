// Rewrites a host `.code-workspace` file into a container-path equivalent (see
// docs/plan-launcher-daemon.md, decision 6). The host original stays the single source of
// truth — this always regenerates a fresh temp file rather than caching one.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveRoot, toContainerPath } from './paths.js';

const WORKSPACE_TMP_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'vscode-shim', 'workspaces');

// Reads `hostWorkspacePath`, resolves each `folders[].path` entry against the workspace
// file's own directory, and validates each against `roots`. Throws (fail closed) if any
// folder falls outside every configured root — the whole workspace is rejected, not just the
// offending folder.
export function buildContainerWorkspace(roots, hostWorkspacePath) {
  const raw = fs.readFileSync(hostWorkspacePath, 'utf8');
  const workspace = JSON.parse(raw);
  const workspaceDir = path.win32.dirname(hostWorkspacePath);

  const folderMounts = [];
  const rewrittenFolders = (workspace.folders || []).map((folder) => {
    const absHostPath = path.win32.resolve(workspaceDir, folder.path);
    const match = resolveRoot(roots, absHostPath);
    if (!match) {
      throw new Error(
        `Workspace folder "${folder.path}" resolves to "${absHostPath}", which is outside every configured root`,
      );
    }
    const containerPath = toContainerPath(match.root, match.relativePath);
    folderMounts.push({ hostPath: absHostPath, containerPath, mode: 'rw' });
    return { ...folder, path: containerPath };
  });

  fs.mkdirSync(WORKSPACE_TMP_DIR, { recursive: true });
  const hash = crypto.createHash('sha256').update(hostWorkspacePath).digest('hex').slice(0, 16);
  const workspaceHostFile = path.join(WORKSPACE_TMP_DIR, `${hash}.code-workspace`);
  fs.writeFileSync(workspaceHostFile, JSON.stringify({ ...workspace, folders: rewrittenFolders }, null, 2));

  return { workspaceHostFile, folderMounts };
}
