// Builds the allow-listed host <-> container bind mounts for `~/.claude` (see
// docs/plan-launcher.md, decision 9). Everything else in `~/.claude` — projects/,
// sessions/, history.jsonl, etc. — stays out of every container's mount namespace; each
// instance gets its own isolated `/home/coder/.claude` volume instead (see lib/docker.js).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildContainerSettingsFile } from "./shimSettings.js";

export interface ClaudeHomeMount {
  hostPath: string;
  containerPath: string;
  mode: "ro" | "rw";
}

const CLAUDE_DIR = path.join(os.homedir(), ".claude");

export function claudeHomeMounts(): ClaudeHomeMount[] {
  const mounts: ClaudeHomeMount[] = [];

  const claudeMd = path.join(CLAUDE_DIR, "CLAUDE.md");
  if (fs.existsSync(claudeMd)) {
    mounts.push({ hostPath: claudeMd, containerPath: "/home/coder/.claude/CLAUDE.md", mode: "ro" });
  } else {
    console.warn(`[launcher] ${claudeMd} not found — skipping CLAUDE.md mount`);
  }

  const credentials = path.join(CLAUDE_DIR, ".credentials.json");
  if (fs.existsSync(credentials)) {
    mounts.push({
      hostPath: credentials,
      containerPath: "/home/coder/.claude/.credentials.json",
      mode: "rw",
    });
  } else {
    console.warn(`[launcher] ${credentials} not found — container will need its own \`claude login\``);
  }

  // Tiny, manually-edited, not customer data — read-write so edits made inside a session
  // propagate back to the host and to every other instance (accepted tradeoff, decision 9).
  const commandsDir = path.join(CLAUDE_DIR, "commands");
  const skillsDir = path.join(CLAUDE_DIR, "skills");
  fs.mkdirSync(commandsDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  mounts.push({ hostPath: commandsDir, containerPath: "/home/coder/.claude/commands", mode: "rw" });
  mounts.push({ hostPath: skillsDir, containerPath: "/home/coder/.claude/skills", mode: "rw" });

  // Shared with every instance and with the host (decision 9 addendum): lets the Claude Code
  // Dashboard's inbox-monitor pattern work inside a container the same way it does natively —
  // the dashboard app writes `<session-id>-inbox.jsonl` here on the host, and the container's
  // own Claude session (same file, same directory) can tail it. Accepted tradeoff: this is one
  // of the folders decision 9 originally excluded (pid/cwd/inbox-message metadata mixed across
  // customers), but unlike `projects/`/`history.jsonl` it holds no transcripts — deliberately
  // re-included after weighing that against the value of dashboard messaging working at all.
  const sessionsDir = path.join(CLAUDE_DIR, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  mounts.push({ hostPath: sessionsDir, containerPath: "/home/coder/.claude/sessions", mode: "rw" });

  const ideDir = path.join(CLAUDE_DIR, "ide");
  fs.mkdirSync(ideDir, { recursive: true });
  mounts.push({ hostPath: ideDir, containerPath: "/home/coder/.claude/ide", mode: "rw" });

  // Shared projects/ directory so the mini-launcher on the host can see Claude sessions
  // created inside the container. Transcript JSONL files are stored here by the Claude
  // extension, keyed by the slug of the container's cwd (/home/coder/project). The
  // mini-launcher resolves this by also looking up sessions via the container-path slug.
  const projectsDir = path.join(CLAUDE_DIR, "projects");
  fs.mkdirSync(projectsDir, { recursive: true });
  mounts.push({ hostPath: projectsDir, containerPath: "/home/coder/.claude/projects", mode: "rw" });

  // Generated from launcher/shim-settings.json (host-editable via the launcher's Settings
  // panel), merged with a forced safety default — see lib/shimSettings.js. Deliberately
  // replaces the image-baked settings.json (unlike decision 9's original stance) now that the
  // merge step guarantees autoInstallIdeExtension can't be silently overridden.
  mounts.push({
    hostPath: buildContainerSettingsFile(),
    containerPath: "/home/coder/.claude/settings.json",
    mode: "ro",
  });

  return mounts;
}