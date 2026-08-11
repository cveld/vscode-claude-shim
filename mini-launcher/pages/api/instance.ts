// GET /api/instance — status of the pinned target's container, if one is running.
// Talks to Docker directly (lib/docker.ts) — no dependency on the main launcher (:4590).

import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs";
import { resolveHostPath } from "@/launcher-lib/paths";
import { roots } from "@/mini-lib/roots";
import { PINNED_DISPLAY_PATH, PINNED_HOST_PATH } from "@/mini-lib/config";
import { getPinnedInstance } from "@/mini-lib/docker";
import { withProxyUrl } from "@/mini-lib/proxy";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
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

  try {
    const instance = await getPinnedInstance(resolved.rootId, resolved.relativePath);
    // Doubles as the proxy-route heartbeat: this endpoint is polled every 5s by the UI, and
    // ensureProxyRoute() memoizes a successful check, so a Caddy restart repairs itself here.
    return res.json({ instance: instance ? await withProxyUrl(instance) : null });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
