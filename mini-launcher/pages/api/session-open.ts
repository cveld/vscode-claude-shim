// POST /api/session-open — resolves how the mini-launcher should open a Claude
// session for the pinned target. For now this honestly falls back to the
// running container root until session targeting is implemented.

import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs";
import { resolveHostPath } from "@/launcher-lib/paths";
import { roots } from "@/mini-lib/roots";
import { PINNED_DISPLAY_PATH, PINNED_HOST_PATH } from "@/mini-lib/config";
import { getPinnedInstance, signalOpenSession } from "@/mini-lib/docker";
import { withProxyUrl } from "@/mini-lib/proxy";
import { listSessionsForFolder } from "@/mini-lib/sessions";
import type { OpenClaudeSessionResult } from "@/mini-lib/api";

type ErrorBody = {
  error: string;
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<OpenClaudeSessionResult | ErrorBody>
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let rawBody: Record<string, unknown> = {};
  try {
    rawBody =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : req.body && typeof req.body === "object"
          ? (req.body as Record<string, unknown>)
          : {};
  } catch {
    rawBody = {};
  }

  const sessionId = typeof rawBody.sessionId === "string" ? rawBody.sessionId.trim() : "";
  const target = rawBody.target === "sidebar" ? "sidebar" : "editor";
  // The sidebar target just docks Claude in the side bar (fresh conversation) — it needs no
  // session. The editor target resumes a specific session, so it does.
  if (target === "editor" && !sessionId) {
    return res.status(400).json({ error: "sessionId is required" });
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
    const [sessions, instance] = await Promise.all([
      listSessionsForFolder(resolved.hostPath, "/home/coder/project"),
      getPinnedInstance(resolved.rootId, resolved.relativePath),
    ]);

    // Whenever a specific session is requested (editor, or sidebar with an id), validate it
    // exists. A sidebar target with no id just docks Claude (fresh conversation) — nothing to
    // validate.
    if (sessionId) {
      const sessionExists = sessions.some((session) => session.id === sessionId);
      if (!sessionExists) {
        return res.status(404).json({ error: "Claude session not found for the pinned folder" });
      }
    }

    if (!instance?.port) {
      return res.status(409).json({ error: "Pinned instance is not running" });
    }

    // Tell the baked-in shim-session-opener extension what to do, then hand the browser the
    // container root. On a fresh window the extension reads the signal on startup; on an
    // already-open window its file watcher acts on it live.
    await signalOpenSession(resolved.rootId, resolved.relativePath, sessionId, target);

    // Prefer the stable proxy URL; fall back to the published port when Caddy is unavailable.
    const proxied = await withProxyUrl(instance);

    return res.json({
      ok: true,
      sessionId,
      openUrl: proxied.proxyUrl ?? `http://localhost:${instance.port}`,
      openMode: "session",
      reason:
        target === "sidebar"
          ? sessionId
            ? "Opening the container; the session will resume in the side bar."
            : "Opening the container; the opener extension will dock Claude in the side bar."
          : "Opening the container; the opener extension will focus this session.",
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
