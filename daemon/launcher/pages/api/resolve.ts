import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'node:fs';
import { resolveHostPath } from '@/daemon-lib/paths';
import { roots } from '../../lib/roots';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const raw = req.query.path;

  if (!raw || Array.isArray(raw)) {
    return res.status(400).json({ error: 'missing path query param' });
  }

  const resolved = resolveHostPath(roots, raw);
  if (!resolved) {
    return res.status(404).json({ error: 'path is outside every configured root' });
  }
  if (!fs.existsSync(resolved.hostPath)) {
    return res.status(404).json({ error: 'path does not exist on host' });
  }

  res.json(resolved);
}