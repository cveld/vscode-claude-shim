// Docker lifecycle for the simulator's pinned target. Uses the same image and
// Claude-home mount strategy as the launcher and mini-launcher, but keeps its
// own labels and helper functions local to this app.

import Docker from "dockerode";
import crypto from "node:crypto";
import { claudeHomeMounts } from "@/simulator-lib/claudeHome";
import type { ResolvedHostPath } from "@/launcher-lib/paths";

const IMAGE = "vscode-claude-shim:latest";
const MANAGED_LABEL = "shim.managed";
const APP_LABEL = "shim.app";
const CONTAINER_PORT = "8080/tcp";

const docker = new Docker({ socketPath: "//./pipe/docker_engine" });

export type Instance = {
  id: string;
  name: string;
  rootId: string;
  relativePath: string;
  type: "folder" | "workspace";
  password: string;
  createdAt: number;
  port: number | null;
  state: string;
};

function projectId(rootId: string, relativePath: string): string {
  const hash = crypto.createHash("sha256").update(relativePath).digest("hex").slice(0, 12);
  return `${rootId}-${hash}`;
}

function toDockerMounts(mounts: { hostPath: string; containerPath: string; mode: string }[]) {
  return mounts.map((m) => ({
    Type: "bind" as const,
    Source: m.hostPath,
    Target: m.containerPath,
    ReadOnly: m.mode === "ro",
  }));
}

function generatePassword(): string {
  return crypto.randomBytes(9).toString("base64url");
}

function summarize(info: Docker.ContainerInspectInfo): Instance {
  const labels = info.Config.Labels || {};
  const hostPort = info.NetworkSettings?.Ports?.[CONTAINER_PORT]?.[0]?.HostPort;
  return {
    id: info.Id.slice(0, 12),
    name: info.Name.replace(/^\//, ""),
    rootId: labels["shim.rootId"],
    relativePath: labels["shim.relativePath"],
    type: labels["shim.type"] as "folder" | "workspace",
    password: labels["shim.password"],
    createdAt: Number(labels["shim.createdAt"]),
    port: hostPort ? Number(hostPort) : null,
    state: info.State?.Status ?? "unknown",
  };
}

export async function getPinnedInstance(rootId: string, relativePath: string): Promise<Instance | null> {
  const container = docker.getContainer(`shim-${projectId(rootId, relativePath)}`);
  try {
    return summarize(await container.inspect());
  } catch (err: any) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

export async function launchPinnedInstance(resolved: ResolvedHostPath): Promise<Instance> {
  if (resolved.type !== "folder") {
    throw new Error("vscode-simulator only supports plain folder targets, not .code-workspace files");
  }

  const id = projectId(resolved.rootId, resolved.relativePath);
  const name = `shim-${id}`;
  const claudeVolumeName = `shim-claude-${id}`;
  const vscodeConfigVolumeName = `shim-vscode-config-${id}`;

  await docker.createVolume({ Name: claudeVolumeName }).catch((err: any) => {
    if (err.statusCode !== 409) throw err;
  });
  await docker.createVolume({ Name: vscodeConfigVolumeName }).catch((err: any) => {
    if (err.statusCode !== 409) throw err;
  });

  const mounts = [
    { Type: "volume" as const, Source: claudeVolumeName, Target: "/home/coder/.claude" },
    { Type: "volume" as const, Source: vscodeConfigVolumeName, Target: "/home/coder/.local/share/code-server" },
    ...toDockerMounts(claudeHomeMounts()),
    { Type: "bind" as const, Source: resolved.hostPath, Target: "/home/coder/project", ReadOnly: false },
  ];

  const password = generatePassword();

  const container = await docker.createContainer({
    name,
    Image: IMAGE,
    Labels: {
      [MANAGED_LABEL]: "true",
      [APP_LABEL]: "vscode-simulator",
      "shim.rootId": resolved.rootId,
      "shim.relativePath": resolved.relativePath,
      "shim.type": "folder",
      "shim.password": password,
      "shim.createdAt": String(Date.now()),
    },
    Cmd: ["--bind-addr", "0.0.0.0:8080", "/home/coder/project"],
    Env: [`PASSWORD=${password}`],
    ExposedPorts: { [CONTAINER_PORT]: {} },
    HostConfig: {
      Mounts: mounts,
      PortBindings: { [CONTAINER_PORT]: [{ HostPort: "" }] },
    },
  });

  await container.start();
  return summarize(await container.inspect());
}

export async function stopPinnedInstance(rootId: string, relativePath: string): Promise<void> {
  const container = docker.getContainer(`shim-${projectId(rootId, relativePath)}`);
  await container.stop().catch((err: any) => {
    if (err.statusCode !== 304 && err.statusCode !== 404) throw err;
  });
  await container.remove().catch((err: any) => {
    if (err.statusCode !== 404) throw err;
  });
}
