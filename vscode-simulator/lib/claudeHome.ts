// Builds the allow-listed host <-> container bind mounts for ~/.claude.
// Kept local to the simulator app so Next.js can compile the API routes without
// pulling TypeScript source from outside the app directory.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildContainerSettingsFile } from "@/simulator-lib/shimSettings";

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
    console.warn(`[simulator] ${claudeMd} not found — skipping CLAUDE.md mount`);
  }

  const credentials = path.join(CLAUDE_DIR, ".credentials.json");
  if (fs.existsSync(credentials)) {
    mounts.push({
      hostPath: credentials,
      containerPath: "/home/coder/.claude/.credentials.json",
      mode: "rw",
    });
  } else {
    console.warn(`[simulator] ${credentials} not found — container will need its own \`claude login\``);
  }

  const commandsDir = path.join(CLAUDE_DIR, "commands");
  const skillsDir = path.join(CLAUDE_DIR, "skills");
  fs.mkdirSync(commandsDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  mounts.push({ hostPath: commandsDir, containerPath: "/home/coder/.claude/commands", mode: "rw" });
  mounts.push({ hostPath: skillsDir, containerPath: "/home/coder/.claude/skills", mode: "rw" });

  const sessionsDir = path.join(CLAUDE_DIR, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  mounts.push({ hostPath: sessionsDir, containerPath: "/home/coder/.claude/sessions", mode: "rw" });

  const ideDir = path.join(CLAUDE_DIR, "ide");
  fs.mkdirSync(ideDir, { recursive: true });
  mounts.push({ hostPath: ideDir, containerPath: "/home/coder/.claude/ide", mode: "rw" });

  const projectsDir = path.join(CLAUDE_DIR, "projects");
  fs.mkdirSync(projectsDir, { recursive: true });
  mounts.push({ hostPath: projectsDir, containerPath: "/home/coder/.claude/projects", mode: "rw" });

  mounts.push({
    hostPath: buildContainerSettingsFile(),
    containerPath: "/home/coder/.claude/settings.json",
    mode: "ro",
  });

  return mounts;
}
