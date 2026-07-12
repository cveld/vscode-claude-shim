import type { NextApiRequest, NextApiResponse } from 'next';
import { createFolder } from '@/daemon-lib/browse';
import { roots } from '../../../lib/roots';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { root, path: relativePath = '', name } = req.body ?? {};

  if (!root || !name) {
    return res.status(400).json({ error: 'missing root or name in request body' });
  }

  try {
    const result = createFolder(roots, root, relativePath, name);
    if (!result) {
      return res.status(404).json({ error: 'unknown root, or path escapes the root' });
    }
    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
}