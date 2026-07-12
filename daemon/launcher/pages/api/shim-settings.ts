import type { NextApiRequest, NextApiResponse } from 'next';
import { readShimSettings, writeShimSettings } from '@/daemon-lib/shimSettings';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    return res.json(readShimSettings());
  }

  if (req.method === 'PUT') {
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return res.status(400).json({ error: 'body must be a JSON object' });
    }
    try {
      writeShimSettings(body);
      return res.status(204).end();
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}