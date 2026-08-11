// GET /api/target — returns resolved metadata for the pinned target folder.
// This is the only place where Node builtins (fs, path) are used to resolve
// the pinned path against roots. Client components call this to get rootId,
// relativePath, etc. without importing Node modules.

import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs";
import { resolveHostPath } from "@/launcher-lib/paths";
import { roots } from "@/mini-lib/roots";
import { PINNED_DISPLAY_PATH, PINNED_HOST_PATH } from "@/mini-lib/config";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const resolved = resolveHostPath(roots, PINNED_HOST_PATH);
  if (!resolved) {
    return res.status(500).json({
      error: `Pinned target is outside every configured root: ${PINNED_DISPLAY_PATH}`,
    });
  }
  if (!fs.existsSync(resolved.hostPath)) {
    return res.status(404).json({ error: "Pinned target path does not exist on host" });
  }

  return res.json(resolved);
}