import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs";
import { resolveHostPath } from "@/launcher-lib/paths";
import { PINNED_HOST_PATH } from "@/simulator-lib/config";
import { roots } from "@/simulator-lib/roots";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const resolved = resolveHostPath(roots, PINNED_HOST_PATH);
  if (!resolved) {
    return res.status(404).json({ error: "Pinned target is outside every configured root" });
  }
  if (!fs.existsSync(resolved.hostPath)) {
    return res.status(404).json({ error: "Pinned target path does not exist on host" });
  }

  return res.json(resolved);
}
