// The simulator uses a dedicated root for its own pinned workspace so it can
// always resolve the self-hosted target, regardless of the main launcher's
// configured allow-list.

import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Root {
  id: string;
  label: string;
  hostPath: string;
  containerPath: string;
}

function loadRoots(): Root[] {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const simulatorDir = path.resolve(__dirname, "..");
  const repoRoot = path.resolve(simulatorDir, "..");

  return [
    {
      id: "vscode-simulator",
      label: "VS Code simulator",
      hostPath: repoRoot,
      containerPath: "/workspaces/vscode-simulator",
    },
  ];
}

export const roots: Root[] = loadRoots();
