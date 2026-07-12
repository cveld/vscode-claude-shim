import type { NextApiRequest, NextApiResponse } from 'next';
import { stopInstance } from '@/daemon-lib/docker';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.query;

  if (!id || Array.isArray(id)) {
    return res.status(400).json({ error: 'missing instance id' });
  }

  try {
    await stopInstance(id);
    return res.status(204).end();
  } catch (err: any) {
    const status = err.statusCode === 404 ? 404 : 500;
    return res.status(status).json({ error: err.message });
  }
}