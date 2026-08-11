import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Wraps an API route handler with uniform error handling.
 * Equivalent to the error-handling patterns from the Express server.js.
 */
export function withErrorHandler(
  handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void> | void,
) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    try {
      await handler(req, res);
    } catch (err: any) {
      if (err.statusCode === 409) {
        return res.status(409).json({ error: 'an instance for this path is already running' });
      }
      if (err.statusCode === 404) {
        return res.status(404).json({ error: err.message });
      }
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  };
}