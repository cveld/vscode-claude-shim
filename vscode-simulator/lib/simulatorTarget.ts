import fs from "node:fs";
import { resolveHostPath } from "@/launcher-lib/paths";
import { PINNED_HOST_PATH } from "@/simulator-lib/config";
import { roots } from "@/simulator-lib/roots";

export type SimulatorTarget = {
  id: string;
  rootId: string;
  relativePath: string;
  hostPath: string;
  type: "folder" | "workspace";
  workspaceFolders: string[];
};

export function getPinnedTarget(): SimulatorTarget {
  const resolved = resolveHostPath(roots, PINNED_HOST_PATH);
  if (!resolved) {
    throw new Error("Pinned target is outside every configured root");
  }
  if (!fs.existsSync(resolved.hostPath)) {
    throw new Error("Pinned target path does not exist on host");
  }
  if (resolved.type !== "folder") {
    throw new Error("vscode-simulator v1 only supports folder targets");
  }

  return {
    id: `${resolved.rootId}:${resolved.relativePath}`,
    rootId: resolved.rootId,
    relativePath: resolved.relativePath,
    hostPath: resolved.hostPath,
    type: resolved.type,
    workspaceFolders: [resolved.hostPath],
  };
}
