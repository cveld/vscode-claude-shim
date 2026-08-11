// Re-exports the roots loader from the main launcher's lib — the mini-launcher
// uses the same roots.json and validation boundary.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Root {
  id: string;
  label: string;
  hostPath: string;
  containerPath: string;
}

function loadRoots(): Root[] {
  const cwdRootsPath = path.resolve(process.cwd(), "../launcher/roots.json");
  if (fs.existsSync(cwdRootsPath)) {
    const { roots } = JSON.parse(fs.readFileSync(cwdRootsPath, "utf8"));
    return roots;
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const moduleRootsPath = path.resolve(__dirname, "../../launcher/roots.json");
  const { roots } = JSON.parse(fs.readFileSync(moduleRootsPath, "utf8"));
  return roots;
}

export const roots: Root[] = loadRoots();