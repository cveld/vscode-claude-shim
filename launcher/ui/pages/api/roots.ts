import type { NextApiRequest, NextApiResponse } from 'next';
import { roots } from '../../lib/roots';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.json(roots.map(({ id, label }) => ({ id, label: label ?? id })));
}