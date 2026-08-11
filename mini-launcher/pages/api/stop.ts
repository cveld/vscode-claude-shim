// POST /api/stop — stops and removes the pinned target's container.

import type { NextApiRequest, NextApiResponse } from "next";
import { resolveHostPath } from "@/launcher-lib/paths";
import { roots } from "@/mini-lib/roots";
import { PINNED_DISPLAY_PATH, PINNED_HOST_PATH } from "@/mini-lib/config";
import { stopPinnedInstance } from "@/mini-lib/docker";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const resolved = resolveHostPath(roots, PINNED_HOST_PATH);
  if (!resolved) {
    return res.status(500).json({
      error: `Pinned target is outside every configured root: ${PINNED_DISPLAY_PATH}`,
    });
  }

  try {
    await stopPinnedInstance(resolved.rootId, resolved.relativePath);
    return res.status(204).end();
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
