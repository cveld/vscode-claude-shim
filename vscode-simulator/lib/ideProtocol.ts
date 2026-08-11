import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const IDE_TRANSPORT = "ws";
export const IDE_HEADER = "x-claude-code-ide-authorization";
export const IDE_NAME = "vscode-simulator";

export type IdeLockfile = {
  pid: string;
  workspaceFolders: string[];
  ideName: string;
  transport: "ws";
  runningInWindows: boolean;
  authToken: string;
};

export function ideLockDir(): string {
  return path.join(os.homedir(), ".claude", "ide");
}

export function ideLockPath(port: number): string {
  return path.join(ideLockDir(), `${port}.lock`);
}

export function generateAuthToken(): string {
  return crypto.randomUUID();
}

export function buildLockfile(port: number, workspaceFolders: string[], authToken: string): IdeLockfile {
  void port;
  return {
    pid: String(process.pid),
    workspaceFolders,
    ideName: IDE_NAME,
    transport: IDE_TRANSPORT,
    runningInWindows: process.platform === "win32",
    authToken,
  };
}

export function writeLockfile(port: number, workspaceFolders: string[], authToken: string): string {
  const lockDir = ideLockDir();
  fs.mkdirSync(lockDir, { recursive: true });
  const lockPath = ideLockPath(port);
  fs.writeFileSync(lockPath, JSON.stringify(buildLockfile(port, workspaceFolders, authToken), null, 2));
  return lockPath;
}

export function removeLockfile(port: number): void {
  const lockPath = ideLockPath(port);
  if (fs.existsSync(lockPath)) {
    fs.unlinkSync(lockPath);
  }
}
