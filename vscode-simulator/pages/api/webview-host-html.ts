import type { NextApiRequest, NextApiResponse } from "next";
import { getShimSession } from "@/simulator-lib/shimSession";

// Return the host-produced HTML the real extension set on a resolved webview view. The browser
// panel reproduces the DOM/globals this HTML declares (#root + data-initial-auth-status, the
// IS_SIDEBAR/IS_FULL_EDITOR globals, the #claude-error sentinel) so the shipped bundle boots
// against the same shell the extension expects — without loading the raw file:// document.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const viewId = typeof req.query.viewId === "string" ? req.query.viewId : "claudeVSCodeSidebar";

  try {
    const session = await getShimSession();
    const html = session.htmlForView(viewId);
    if (!html) {
      return res.status(404).json({ error: `No host HTML captured for view ${viewId}`, viewIds: session.viewIds() });
    }
    return res.json({ viewId, html });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
