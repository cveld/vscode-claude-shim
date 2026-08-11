// Claude session reading logic — adapted from claude-code-dashboard patterns:
//   app/lib/peekJsonl.ts   — streaming JSONL summary parser
//   app/lib/dashboard.ts   — pathToSlug, session types
//   app/api/active-sessions/route.ts — active session detection
//
// Reads ~/.claude/projects/<slug>/*.jsonl for transcript sessions
// and ~/.claude/sessions/*.json for currently active Claude processes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

// ---- Slug encoding (same as dashboard) ----

export function pathToSlug(folderPath: string): string {
  return folderPath.replace(/[:\\/\s]/g, "-");
}

// ---- Types ----

export interface SessionSummary {
  id: string;
  title: string | null;
  firstUserMessage: string | null;
  startedAt: string | null;
  lastActivity: string | null;
  messageCount: number;
  totalTokensBurned: number;
}

export interface ActiveSessionInfo {
  sessionId: string;
  cwd: string;
  pid: number;
  startedAt: number;
}

// ---- Peek cache (mtime-based, same pattern as dashboard) ----

interface CacheEntry extends SessionSummary {
  mtime: string;
}

function sessionIdFromFilename(filename: string): string {
  return filename.replace(/\.jsonl$/, "");
}

function withCanonicalSessionId<T extends SessionSummary>(summary: T, filename: string): T {
  return {
    ...summary,
    id: sessionIdFromFilename(filename),
  };
}

interface PeekCache {
  [filename: string]: CacheEntry;
}

const CACHE_FILE = ".peek-cache.json";

function loadCache(projectDir: string): PeekCache {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectDir, CACHE_FILE), "utf-8"));
  } catch {
    return {};
  }
}

function saveCache(projectDir: string, cache: PeekCache): void {
  try {
    fs.writeFileSync(path.join(projectDir, CACHE_FILE), JSON.stringify(cache), "utf-8");
  } catch {
    // best-effort
  }
}

// ---- JSONL summary peek (adapted from dashboard peekJsonl.ts) ----

async function peekJsonl(filePath: string): Promise<SessionSummary> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity,
    });

    let messageCount = 0;
    let startedAt: string | null = null;
    let firstUserMessage: string | null = null;
    let aiTitle: string | null = null;
    let customTitle: string | null = null;
    let lastActivity: string | null = null;
    let burnedInput = 0;
    let burnedCacheCreation = 0;
    let burnedCacheRead = 0;
    let burnedOutput = 0;

    rl.on("line", (line) => {
      if (!line.trim()) return;
      messageCount++;
      try {
        const obj = JSON.parse(line);
        if (!startedAt && obj.timestamp) startedAt = obj.timestamp;
        if (obj.type === "ai-title" && obj.aiTitle) aiTitle = obj.aiTitle;
        if (obj.type === "custom-title" && obj.customTitle) customTitle = obj.customTitle;
        if (!firstUserMessage && obj.type === "user" && obj.message?.content) {
          const content = obj.message.content;
          if (typeof content === "string") {
            firstUserMessage = content.slice(0, 120);
          } else if (Array.isArray(content)) {
            const textBlock = content.find(
              (b: { type: string; text?: string }) => b.type === "text"
            );
            if (textBlock?.text) firstUserMessage = textBlock.text.slice(0, 120);
          }
        }
        if (obj.type === "assistant" && obj.message?.usage) {
          const u = obj.message.usage;
          burnedInput += u.input_tokens ?? 0;
          burnedCacheCreation += u.cache_creation_input_tokens ?? 0;
          burnedCacheRead += u.cache_read_input_tokens ?? 0;
          burnedOutput += u.output_tokens ?? 0;
        }
        if ((obj.type === "user" || obj.type === "assistant") && obj.timestamp) {
          lastActivity = obj.timestamp;
        }
        if (!lastActivity && obj.timestamp) {
          lastActivity = obj.timestamp;
        }
      } catch {
        // skip malformed lines
      }
    });

    rl.on("close", () =>
      resolve({
        id: "", // filled by caller
        title: customTitle ?? aiTitle,
        firstUserMessage,
        startedAt,
        lastActivity,
        messageCount,
        totalTokensBurned: burnedInput + burnedCacheCreation + burnedCacheRead + burnedOutput,
      })
    );
  });
}

async function peekJsonlCached(
  filePath: string,
  filename: string,
  mtime: Date,
  cache: PeekCache
): Promise<SessionSummary> {
  const mtimeStr = mtime.toISOString();
  const entry = cache[filename];
  if (entry && entry.mtime === mtimeStr) {
    const result = withCanonicalSessionId(entry, filename);
    cache[filename] = { ...result, mtime: mtimeStr };
    const { mtime: _m, ...summary } = cache[filename];
    return summary;
  }
  const result = withCanonicalSessionId(await peekJsonl(filePath), filename);
  cache[filename] = { ...result, mtime: mtimeStr };
  return result;
}

// ---- Active session reading ----

function readActiveSessions(): ActiveSessionInfo[] {
  const sessionsDir = path.join(os.homedir(), ".claude", "sessions");
  const active: ActiveSessionInfo[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return active;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const raw = fs.readFileSync(path.join(sessionsDir, entry.name), "utf-8");
      const obj = JSON.parse(raw);
      if (obj.sessionId && obj.cwd) {
        active.push({
          sessionId: obj.sessionId,
          cwd: obj.cwd,
          pid: obj.pid,
          startedAt: obj.startedAt,
        });
      }
    } catch {
      // skip unreadable files
    }
  }
  return active;
}

// ---- Public API ----

export interface SessionWithActive extends SessionSummary {
  isActive: boolean;
}

/**
 * Returns all Claude sessions for a given host folder path.
 * Combines transcript sessions from ~/.claude/projects/<slug>/*.jsonl
 * with active/live state from ~/.claude/sessions/*.json.
 *
 * Sessions are looked up by both the host-path slug AND the container-path
 * slug, because code-server records sessions with the container's internal
 * cwd (e.g. /home/coder/project → -home-coder-project) while the host-side
 * mini-launcher computes the slug from the Windows host path.
 */
export async function listSessionsForFolder(
  hostPath: string,
  containerPath?: string
): Promise<SessionWithActive[]> {
  const hostSlug = pathToSlug(hostPath);
  const containerSlug = containerPath ? pathToSlug(containerPath) : null;

  // Build the set of project directories to check
  const projectDirs: string[] = [];
  const hostDir = path.join(os.homedir(), ".claude", "projects", hostSlug);
  projectDirs.push(hostDir);
  if (containerSlug && containerSlug !== hostSlug) {
    projectDirs.push(path.join(os.homedir(), ".claude", "projects", containerSlug));
  }

  // Read active sessions and build lookup by sessionId for those matching this folder
  const allActive = readActiveSessions();
  const activeSlugs = new Set([hostSlug]);
  if (containerSlug) activeSlugs.add(containerSlug);
  const activeSet = new Set(
    allActive
      .filter((a) => activeSlugs.has(pathToSlug(a.cwd)))
      .map((a) => a.sessionId)
  );

  // Gather transcript files from all matching project directories
  const results: SessionWithActive[] = [];
  const seen = new Set<string>();

  for (const projectDir of projectDirs) {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }

    const jsonlFiles = dirents.filter(
      (d) => d.isFile() && d.name.endsWith(".jsonl") && !d.name.startsWith(".")
    );

    if (jsonlFiles.length === 0) continue;

    const cache = loadCache(projectDir);

    for (const d of jsonlFiles) {
      const id = d.name.replace(/\.jsonl$/, "");
      if (seen.has(id)) continue;
      seen.add(id);

      const filePath = path.join(projectDir, d.name);
      const { mtime } = fs.statSync(filePath);
      const summary = await peekJsonlCached(filePath, d.name, mtime, cache);
      results.push({
        ...summary,
        isActive: activeSet.has(summary.id),
      });
    }

    saveCache(projectDir, cache);
  }

  // Sort by last activity descending
  results.sort((a, b) => {
    const da = a.lastActivity ?? a.startedAt ?? "";
    const db = b.lastActivity ?? b.startedAt ?? "";
    return db.localeCompare(da);
  });

  return results;
}