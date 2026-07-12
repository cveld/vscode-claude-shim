import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'node:fs';
import { resolveHostPath, toHostPath } from '@/daemon-lib/paths';
import { buildContainerWorkspace } from '@/daemon-lib/workspace';
import { createInstance, listInstances } from '@/daemon-lib/docker';
import { recordLaunch } from '@/daemon-lib/history';
import { roots } from '../../lib/roots';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const instances = await listInstances();
    return res.json(instances);
  }

  if (req.method === 'POST') {
    const { path: raw, rootId, relativePath } = req.body ?? {};
    let resolved;

    if (raw) {
      resolved = resolveHostPath(roots, raw);
    } else if (rootId !== undefined && relativePath !== undefined) {
      const root = roots.find((r) => r.id === rootId);
      if (!root) {
        return res.status(404).json({ error: 'unknown root' });
      }
      resolved = resolveHostPath(roots, toHostPath(root, relativePath));
    } else {
      return res.status(400).json({ error: 'missing path, or rootId/relativePath, in request body' });
    }

    if (!resolved) {
      return res.status(404).json({ error: 'path is outside every configured root' });
    }
    if (!fs.existsSync(resolved.hostPath)) {
      return res.status(404).json({ error: 'path does not exist on host' });
    }

    try {
      const launchSpec =
        resolved.type === 'workspace'
          ? { ...resolved, ...buildContainerWorkspace(roots, resolved.hostPath) }
          : resolved;
      const instance = await createInstance(launchSpec);
      recordLaunch({
        rootId: resolved.rootId,
        relativePath: resolved.relativePath,
        type: resolved.type,
      });
      return res.status(201).json(instance);
    } catch (err: any) {
      if (err.statusCode === 409) {
        return res.status(409).json({ error: 'an instance for this path is already running' });
      }
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}