import type { NextApiRequest, NextApiResponse } from 'next';
import { browse } from '@/daemon-lib/browse';
import { roots } from '../../lib/roots';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { root, path: relativePath = '' } = req.query;

  if (!root || Array.isArray(root)) {
    return res.status(400).json({ error: 'missing root query param' });
  }

  try {
    const result = browse(roots, root, Array.isArray(relativePath) ? relativePath[0] : relativePath);
    if (!result) {
      return res.status(404).json({ error: 'unknown root, or path escapes the root' });
    }
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
}