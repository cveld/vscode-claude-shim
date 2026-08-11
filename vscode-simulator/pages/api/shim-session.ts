import type { NextApiRequest, NextApiResponse } from "next";
import { getActivationCount, getShimSession, resetShimSession } from "@/simulator-lib/shimSession";

// Minimal status/verification endpoint for the persistent shim session (build-plan slice 1).
// GET  -> ensure the session exists and report its live state.
// POST { reset: true } -> drop the session so the next GET re-activates.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "POST" && req.body?.reset) {
    resetShimSession();
    return res.json({ reset: true });
  }
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const session = await getShimSession();
    return res.json({
      activationCount: getActivationCount(),
      activationCompleted: session.activation.activationCompleted,
      activationError: session.activation.activationError,
      viewIds: session.viewIds(),
      outboundCount: session.outboundCount(),
      recentLogs: session.recentLogs(60),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
