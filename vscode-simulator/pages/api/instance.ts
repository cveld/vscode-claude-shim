import type { NextApiRequest, NextApiResponse } from "next";
import { getPinnedTarget } from "@/simulator-lib/simulatorTarget";
import { simulatorRuntime } from "@/simulator-lib/simulatorRuntime";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    getPinnedTarget();
    const state = simulatorRuntime.getState();
    return res.json({ instance: state.state === "stopped" ? null : state });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
