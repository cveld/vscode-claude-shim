import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type IdeLock = {
  port: number;
  pid: string;
  workspaceFolders: string[];
  ideName: string;
  transport: string;
  runningInWindows: boolean;
  authToken: string;
};

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const ideDir = path.join(os.homedir(), ".claude", "ide");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(ideDir, { withFileTypes: true });
  } catch {
    return res.json([]);
  }

  const locks: IdeLock[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".lock")) continue;
    const port = Number(entry.name.replace(/\.lock$/, ""));
    if (!Number.isFinite(port)) continue;

    try {
      const raw = fs.readFileSync(path.join(ideDir, entry.name), "utf-8");
      const parsed = JSON.parse(raw);
      locks.push({
        port,
        pid: String(parsed.pid ?? ""),
        workspaceFolders: Array.isArray(parsed.workspaceFolders) ? parsed.workspaceFolders : [],
        ideName: typeof parsed.ideName === "string" ? parsed.ideName : "",
        transport: typeof parsed.transport === "string" ? parsed.transport : "",
        runningInWindows: Boolean(parsed.runningInWindows),
        authToken: typeof parsed.authToken === "string" ? parsed.authToken : "",
      });
    } catch {
      // Skip malformed lock files.
    }
  }

  return res.json(locks);
}