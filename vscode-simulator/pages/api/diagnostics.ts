import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IDE_HEADER, ideLockDir } from "@/simulator-lib/ideProtocol";
import { getPinnedTarget } from "@/simulator-lib/simulatorTarget";
import { simulatorRuntime } from "@/simulator-lib/simulatorRuntime";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const claudeDir = path.join(os.homedir(), ".claude");
  const notes = [
    "This version simulates the documented lock-file plus WebSocket discovery flow only.",
    "The runtime listens on a dedicated localhost port instead of reusing the Next.js UI port.",
    "A successful WebSocket connection only proves transport compatibility, not full VS Code API parity.",
  ];

  let claudeDirWritable = false;
  try {
    fs.accessSync(claudeDir, fs.constants.W_OK);
    claudeDirWritable = true;
  } catch {
    claudeDirWritable = false;
  }

  try {
    const target = getPinnedTarget();
    const state = simulatorRuntime.getState();
    return res.json({
      lockFileDir: ideLockDir(),
      transport: "ws",
      authorizationHeader: IDE_HEADER,
      lockFileFields: ["pid", "workspaceFolders", "ideName", "transport", "runningInWindows", "authToken"],
      claudeDirWritable,
      pinnedTargetExists: true,
      pinnedTargetInAllowedRoot: true,
      runtimeState: state.state,
      port: state.port,
      pid: state.pid,
      lockFilePath: state.lockFilePath,
      workspaceFolders: target.workspaceFolders,
      lastConnectionAt: state.lastConnectionAt,
      lastError: state.lastError,
      notes,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
