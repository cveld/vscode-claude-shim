import type { NextApiRequest, NextApiResponse } from "next";
import { getShimSummary } from "@/simulator-lib/extensionHostShim";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    return res.json(await getShimSummary());
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
