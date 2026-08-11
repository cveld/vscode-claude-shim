// POST /api/launch — starts the container for the pinned target (or resumes an existing one
// via Docker's own name-conflict/volume-reuse behavior).

import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs";
import { resolveHostPath } from "@/launcher-lib/paths";
import { roots } from "@/mini-lib/roots";
import { PINNED_DISPLAY_PATH, PINNED_HOST_PATH } from "@/mini-lib/config";
import { launchPinnedInstance } from "@/mini-lib/docker";
import { withProxyUrl } from "@/mini-lib/proxy";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const resolved = resolveHostPath(roots, PINNED_HOST_PATH);
    if (!resolved) {
      return res.status(500).json({
        error: `Pinned target is outside every configured root: ${PINNED_DISPLAY_PATH}`,
      });
    }
    if (!fs.existsSync(resolved.hostPath)) {
      return res.status(404).json({ error: "Pinned target path does not exist on host" });
    }

    const instance = await launchPinnedInstance(resolved);
    // Ensure the proxy route before handing out the URL, so the link works the moment it appears.
    return res.json(await withProxyUrl(instance));
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
