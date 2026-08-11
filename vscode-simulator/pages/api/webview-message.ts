import type { NextApiRequest, NextApiResponse } from "next";
import { getShimSession } from "@/simulator-lib/shimSession";

// Browser→host relay for the persistent shim session (build-plan slice 3). The browser panel
// POSTs each `postMessage` the real webview bundle emits; we deliver it verbatim (no wrapper
// envelope, matching the real contract) into the extension's onDidReceiveMessage listeners
// for the target view. Any host→webview replies the extension produces flow back through the
// SSE stream (/api/webview-stream), not this response.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { viewId, message } = req.body ?? {};
  if (typeof viewId !== "string" || message === undefined) {
    return res.status(400).json({ error: "Body must include a string viewId and a message" });
  }

  try {
    const session = await getShimSession();
    const delivered = session.dispatchToView(viewId, message);
    if (!delivered) {
      return res.status(404).json({ error: `Unknown viewId: ${viewId}`, viewIds: session.viewIds() });
    }
    return res.json({ delivered: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
