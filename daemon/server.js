import express from 'express';
import next from 'next';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHostPath, toHostPath } from './lib/paths.js';
import { browse, createFolder } from './lib/browse.js';
import { buildContainerWorkspace } from './lib/workspace.js';
import { createInstance, listInstances, stopInstance } from './lib/docker.js';
import { recordLaunch, listRecent } from './lib/history.js';
import { readShimSettings, writeShimSettings } from './lib/shimSettings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { roots } = JSON.parse(fs.readFileSync(path.join(__dirname, 'roots.json'), 'utf8'));

const app = express();
app.use(express.json());

// Read-only, filesystem-only — no Docker calls.
app.get('/api/browse', (req, res) => {
  const { root, path: relativePath = '' } = req.query;
  if (!root) return res.status(400).json({ error: 'missing root query param' });
  try {
    const result = browse(roots, root, relativePath);
    if (!result) return res.status(404).json({ error: 'unknown root, or path escapes the root' });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Creates a new subfolder under an existing browsed directory. Filesystem-only — no Docker
// calls, same trust boundary as GET /api/browse.
app.post('/api/browse/folder', (req, res) => {
  const { root, path: relativePath = '', name } = req.body ?? {};
  if (!root || !name) return res.status(400).json({ error: 'missing root or name in request body' });
  try {
    const result = createFolder(roots, root, relativePath, name);
    if (!result) return res.status(404).json({ error: 'unknown root, or path escapes the root' });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Roots list for the launcher UI's picker. Deliberately exposes only `id`/`label`, never
// `hostPath` — real filesystem paths stay a server-only concern (decision 5 in the plan doc).
app.get('/api/roots', (req, res) => {
  res.json(roots.map(({ id, label }) => ({ id, label: label ?? id })));
});

app.get('/api/resolve', (req, res) => {
  const raw = req.query.path;
  if (!raw) return res.status(400).json({ error: 'missing path query param' });
  const resolved = resolveHostPath(roots, raw);
  if (!resolved) return res.status(404).json({ error: 'path is outside every configured root' });
  if (!fs.existsSync(resolved.hostPath)) return res.status(404).json({ error: 'path does not exist on host' });
  res.json(resolved);
});

// Accepts either `{ path }` (a raw pasted absolute host path — the paste-path box) or
// `{ rootId, relativePath }` (the drill-down browser, which never sees a raw host path).
// Both are funneled through the same `resolveHostPath` validation before touching Docker.
app.post('/api/instances', async (req, res) => {
  const { path: raw, rootId, relativePath } = req.body ?? {};
  let resolved;
  if (raw) {
    resolved = resolveHostPath(roots, raw);
  } else if (rootId !== undefined && relativePath !== undefined) {
    const root = roots.find((r) => r.id === rootId);
    if (!root) return res.status(404).json({ error: 'unknown root' });
    resolved = resolveHostPath(roots, toHostPath(root, relativePath));
  } else {
    return res.status(400).json({ error: 'missing path, or rootId/relativePath, in request body' });
  }
  if (!resolved) return res.status(404).json({ error: 'path is outside every configured root' });
  if (!fs.existsSync(resolved.hostPath)) return res.status(404).json({ error: 'path does not exist on host' });

  try {
    const launchSpec =
      resolved.type === 'workspace' ? { ...resolved, ...buildContainerWorkspace(roots, resolved.hostPath) } : resolved;
    const instance = await createInstance(launchSpec);
    recordLaunch({ rootId: resolved.rootId, relativePath: resolved.relativePath, type: resolved.type });
    res.status(201).json(instance);
  } catch (err) {
    if (err.statusCode === 409) return res.status(409).json({ error: 'an instance for this path is already running' });
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/instances', async (req, res) => {
  res.json(await listInstances());
});

// Merged into every container's ~/.claude/settings.json at launch (lib/shimSettings.js);
// autoInstallIdeExtension is forced off regardless of what's stored here.
app.get('/api/shim-settings', (req, res) => {
  res.json(readShimSettings());
});

app.put('/api/shim-settings', (req, res) => {
  const body = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return res.status(400).json({ error: 'body must be a JSON object' });
  }
  try {
    writeShimSettings(body);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bounded list of previously launched projects (docs/plan-launcher-daemon.md) — survives a
// project's own stop/relaunch cycles, unlike GET /api/instances which only reflects containers
// that still exist.
app.get('/api/recent', (req, res) => {
  res.json(listRecent());
});

app.post('/api/instances/:id/stop', async (req, res) => {
  try {
    await stopInstance(req.params.id);
    res.status(204).end();
  } catch (err) {
    res.status(err.statusCode === 404 ? 404 : 500).json({ error: err.message });
  }
});

// Everything that isn't one of the /api/* routes above falls through to the launcher UI —
// a Next.js app embedded via its custom-server API (docs/plan-launcher-daemon.md, build order
// item 3) rather than a separate always-running process, so there's still exactly one
// process/port in both dev and production.
const dev = process.env.NODE_ENV !== 'production';
const nextApp = next({ dev, dir: path.join(__dirname, 'launcher') });
const handleNextRequest = nextApp.getRequestHandler();
app.use((req, res) => handleNextRequest(req, res));

const PORT = process.env.DAEMON_PORT || 4590;
nextApp.prepare().then(() => {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`[daemon] listening on http://127.0.0.1:${PORT}`);
  });
});
