import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Root {
  id: string;
  label: string;
  hostPath: string;
  containerPath: string;
}

function loadRoots(): Root[] {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const rootsPath = path.resolve(__dirname, '../../roots.json');
  const { roots } = JSON.parse(fs.readFileSync(rootsPath, 'utf8'));
  return roots;
}

// Module-level cache: loaded once when the module is first imported.
// This is correct because the daemon runs as a long-lived Node process
// (next dev / next start), not as serverless functions.
export const roots: Root[] = loadRoots();