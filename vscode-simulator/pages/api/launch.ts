import type { NextApiRequest, NextApiResponse } from "next";
import { getPinnedTarget } from "@/simulator-lib/simulatorTarget";
import { simulatorRuntime } from "@/simulator-lib/simulatorRuntime";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    getPinnedTarget();
    const instance = await simulatorRuntime.start();
    return res.json(instance);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
