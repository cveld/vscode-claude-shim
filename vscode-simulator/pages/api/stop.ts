import type { NextApiRequest, NextApiResponse } from "next";
import { simulatorRuntime } from "@/simulator-lib/simulatorRuntime";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    await simulatorRuntime.stop();
    return res.status(204).end();
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
