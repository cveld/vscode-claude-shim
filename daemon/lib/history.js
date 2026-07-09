// Persists a bounded "recently launched" list across daemon restarts and container
// stop/relaunch cycles. Docker itself remembers nothing about a project once its container is
// stopped (`stopInstance` removes it, per docs/plan-launcher-daemon.md decision 8's manual-stop
// model), so this is the only place that remembers what's been launched before.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HISTORY_FILE = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'vscode-shim', 'recent.json');
const MAX_ENTRIES = 20;

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')).entries ?? [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function writeAll(entries) {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify({ entries }, null, 2));
}

// Upserts by (rootId, relativePath): a relaunch of the same project moves it to the front with
// a fresh timestamp instead of appending a duplicate.
export function recordLaunch({ rootId, relativePath, type }) {
  const entries = readAll().filter((e) => !(e.rootId === rootId && e.relativePath === relativePath));
  entries.unshift({ rootId, relativePath, type, lastLaunchedAt: Date.now() });
  writeAll(entries.slice(0, MAX_ENTRIES));
}

export function listRecent() {
  return readAll().sort((a, b) => b.lastLaunchedAt - a.lastLaunchedAt);
}
