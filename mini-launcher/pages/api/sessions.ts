// GET /api/sessions — returns Claude chat sessions for the pinned folder.
// Reads ~/.claude/projects/<slug>/*.jsonl transcripts and correlates with
// active sessions from ~/.claude/sessions/*.json.

import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs";
import { resolveHostPath } from "@/launcher-lib/paths";
import { roots } from "@/mini-lib/roots";
import { PINNED_DISPLAY_PATH, PINNED_HOST_PATH } from "@/mini-lib/config";
import { getPinnedInstance } from "@/mini-lib/docker";
import { listSessionsForFolder } from "@/mini-lib/sessions";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Validate pinned path first
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
    const [sessions, instance] = await Promise.all([
      listSessionsForFolder(resolved.hostPath, "/home/coder/project"),
      getPinnedInstance(resolved.rootId, resolved.relativePath),
    ]);
    const instanceUrl = instance?.port ? `http://localhost:${instance.port}` : null;
    return res.json(
      sessions
        .map((session) => {
          const sessionId = typeof session.id === "string" ? session.id.trim() : "";
          if (!sessionId) return null;

          return {
            ...session,
            id: sessionId,
            instanceUrl,
            canOpen: Boolean(instanceUrl),
            openMode: "session-open" as const,
          };
        })
        .filter(Boolean)
    );
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}