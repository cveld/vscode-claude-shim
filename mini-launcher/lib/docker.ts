// Standalone Docker logic for the mini-launcher's single pinned target — mini-launcher does
// not depend on the main launcher (port 4590) being up. Talks to Docker Desktop directly via
// dockerode, same connection pattern as launcher/lib/docker.js, but only ever manages the one
// container for the pinned folder (no root browsing, no `.code-workspace` support).

import Docker from "dockerode";
import crypto from "node:crypto";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { claudeHomeMounts } from "@/launcher-lib/claudeHome";
import type { ResolvedHostPath } from "@/launcher-lib/paths";
import { PROXY_NETWORK, slugFor } from "@/mini-lib/proxy";

const IMAGE = "vscode-claude-shim:latest";
const MANAGED_LABEL = "shim.managed";
const CONTAINER_PORT = "8080/tcp";
const DOCKER_PIPE = "//./pipe/docker_engine";
const DOCKER_DESKTOP_PATH = "C:/Program Files/Docker/Docker/Docker Desktop.exe";

const docker = new Docker({ socketPath: DOCKER_PIPE });
let dockerStartupPromise: Promise<void> | null = null;

/**
 * Env handed to every instance the launcher creates. The session broker is opt-in and off by
 * default; set SHIM_SESSION_BROKER=1 on the launcher process to switch it on for containers created
 * from then on. It cannot be applied to an existing container — Docker env is fixed at create time —
 * so an instance has to be removed and relaunched to pick it up. See docs/plan-session-broker.md.
 */
function instanceEnv(): string[] {
  const env: string[] = [];
  if (process.env.SHIM_SESSION_BROKER === "1") env.push("SHIM_SESSION_BROKER=1");
  return env;
}

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
  /** Subdomain label the Caddy proxy reaches this instance by; also its Docker network alias. */
  slug: string;
};

// Stable per-project id — matches launcher/lib/docker.js's scheme, so a folder launched via
// the mini-launcher and via the main launcher resolve to the same container/volumes.
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

function summarize(info: Docker.ContainerInspectInfo): Instance {
  const labels = info.Config.Labels || {};
  const hostPort = info.NetworkSettings?.Ports?.[CONTAINER_PORT]?.[0]?.HostPort;
  const rootId = labels["shim.rootId"];
  const relativePath = labels["shim.relativePath"];
  return {
    id: info.Id.slice(0, 12),
    name: info.Name.replace(/^\//, ""),
    rootId,
    relativePath,
    type: labels["shim.type"] as "folder" | "workspace",
    password: "",
    createdAt: Number(labels["shim.createdAt"]),
    port: hostPort ? Number(hostPort) : null,
    state: info.State?.Status ?? "unknown",
    // Derived, not read from a label, so containers created before the proxy existed also get one.
    slug: slugFor(rootId, relativePath),
  };
}

function isRunningInstance(instance: Instance): boolean {
  return instance.state === "running";
}

// The proxy reaches instances over Docker DNS on a shared network, so both Caddy and the instance
// must be attached to it — Caddy dials the container by its network alias (see lib/proxy.ts).
async function ensureProxyNetwork(): Promise<void> {
  await docker.createNetwork({ Name: PROXY_NETWORK }).catch((err: any) => {
    if (err.statusCode !== 409) throw err; // 409 = already exists
  });
}

// Best-effort: attaching an already-created container (one from before the proxy existed, or simply
// a relaunch) must never block a launch — without it the instance is still reachable on its
// published port, which the UI keeps offering as a fallback.
async function attachToProxyNetwork(containerName: string, slug: string): Promise<void> {
  try {
    await ensureProxyNetwork();
    await docker.getNetwork(PROXY_NETWORK).connect({
      Container: containerName,
      EndpointConfig: { Aliases: [slug] },
    });
  } catch (err: any) {
    const alreadyAttached = err?.statusCode === 403 || err?.statusCode === 409;
    if (!alreadyAttached) {
      console.warn(`[proxy] could not attach ${containerName} to ${PROXY_NETWORK}: ${err?.message ?? err}`);
    }
  }
}

async function inspectPinnedContainer(rootId: string, relativePath: string): Promise<Docker.ContainerInspectInfo | null> {
  const container = docker.getContainer(`shim-${projectId(rootId, relativePath)}`);
  try {
    return await container.inspect();
  } catch (err: any) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldTryStartingDocker(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("ENOENT") || message.includes("docker_engine") || message.includes("dockerDesktopLinuxEngine");
}

async function ensureDockerAvailable(): Promise<void> {
  try {
    await docker.ping();
    return;
  } catch (err) {
    if (!shouldTryStartingDocker(err)) throw err;
  }

  if (!dockerStartupPromise) {
    dockerStartupPromise = startDockerDesktop().finally(() => {
      dockerStartupPromise = null;
    });
  }
  await dockerStartupPromise;
}

async function startDockerDesktop(): Promise<void> {
  if (!fs.existsSync(DOCKER_DESKTOP_PATH)) {
    throw new Error(`Docker Desktop not found at ${DOCKER_DESKTOP_PATH}`);
  }

  spawn(DOCKER_DESKTOP_PATH, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();

  const deadline = Date.now() + 120_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      await docker.ping();
      return;
    } catch (err) {
      lastError = err;
      await sleep(2000);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Docker Desktop did not become ready in time");
}

export async function getPinnedInstance(rootId: string, relativePath: string): Promise<Instance | null> {
  await ensureDockerAvailable();
  const info = await inspectPinnedContainer(rootId, relativePath);
  if (!info) return null;

  const instance = summarize(info);
  return isRunningInstance(instance) ? instance : null;
}

export async function launchPinnedInstance(resolved: ResolvedHostPath): Promise<Instance> {
  await ensureDockerAvailable();
  if (resolved.type !== "folder") {
    throw new Error("mini-launcher only supports plain folder targets, not .code-workspace files");
  }

  const id = projectId(resolved.rootId, resolved.relativePath);
  const name = `shim-${id}`;
  const claudeVolumeName = `shim-claude-${id}`;
  const vscodeConfigVolumeName = `shim-vscode-config-${id}`;

  await docker.createVolume({ Name: claudeVolumeName }).catch((err: any) => {
    if (err.statusCode !== 409) throw err; // already exists — this is what gives a relaunch its history back.
  });
  await docker.createVolume({ Name: vscodeConfigVolumeName }).catch((err: any) => {
    if (err.statusCode !== 409) throw err;
  });

  const slug = slugFor(resolved.rootId, resolved.relativePath);

  const existing = await inspectPinnedContainer(resolved.rootId, resolved.relativePath);
  if (existing) {
    const existingInstance = summarize(existing);
    await attachToProxyNetwork(name, slug);
    if (isRunningInstance(existingInstance)) {
      return existingInstance;
    }

    const container = docker.getContainer(name);
    await container.start();
    return summarize(await container.inspect());
  }

  await ensureProxyNetwork();

  const mounts = [
    { Type: "volume" as const, Source: claudeVolumeName, Target: "/home/coder/.claude" },
    { Type: "volume" as const, Source: vscodeConfigVolumeName, Target: "/home/coder/.local/share/code-server" },
    ...toDockerMounts(claudeHomeMounts()),
    { Type: "bind" as const, Source: resolved.hostPath, Target: "/home/coder/project", ReadOnly: false },
  ];

  const container = await docker.createContainer({
    name,
    Image: IMAGE,
    Labels: {
      [MANAGED_LABEL]: "true",
      "shim.rootId": resolved.rootId,
      "shim.relativePath": resolved.relativePath,
      "shim.type": "folder",
      "shim.createdAt": String(Date.now()),
      "shim.slug": slug,
    },
    Cmd: ["--auth", "none", "--bind-addr", "0.0.0.0:8080", "/home/coder/project"],
    Env: instanceEnv(),
    ExposedPorts: { [CONTAINER_PORT]: {} },
    HostConfig: {
      Mounts: mounts,
      // Kept published even though the proxy makes the port unnecessary: it is the fallback link
      // when Caddy is not running, so the launcher never depends on infrastructure outside this repo.
      PortBindings: { [CONTAINER_PORT]: [{ HostPort: "" }] },
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [PROXY_NETWORK]: { Aliases: [slug] },
      },
    },
  });

  await container.start();
  return summarize(await container.inspect());
}

// Signal the baked-in shim-session-opener extension (see
// container-assets/shim-session-opener/) to open a specific Claude session. code-server has no
// way to deep-link into the extension's chat panel via URL, so we drop a small JSON file into
// the container that the extension reads on startup and watches while running. `ts` is a nonce
// so re-clicking the same session still triggers an open.
const SIGNAL_FILE = "/home/coder/.claude/.shim-open-session";

export type OpenTarget = "editor" | "sidebar";

export async function signalOpenSession(
  rootId: string,
  relativePath: string,
  sessionId: string,
  target: OpenTarget = "editor",
): Promise<void> {
  await ensureDockerAvailable();
  const container = docker.getContainer(`shim-${projectId(rootId, relativePath)}`);
  const payload = JSON.stringify({ sessionId, ts: Date.now(), target });
  // base64 the payload so it survives the shell without quoting/escaping surprises.
  const encoded = Buffer.from(payload, "utf8").toString("base64");
  const exec = await container.exec({
    Cmd: ["sh", "-c", `printf %s '${encoded}' | base64 -d > '${SIGNAL_FILE}'`],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({});
  await new Promise<void>((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("error", reject);
    stream.resume(); // drain output we don't need
  });
  const info = await exec.inspect();
  if (info.ExitCode) {
    throw new Error(`Failed to signal session open (exit ${info.ExitCode})`);
  }
}

export async function stopPinnedInstance(rootId: string, relativePath: string): Promise<void> {
  await ensureDockerAvailable();
  const container = docker.getContainer(`shim-${projectId(rootId, relativePath)}`);
  await container.stop().catch((err: any) => {
    if (err.statusCode !== 304 && err.statusCode !== 404) throw err; // 304 = already stopped
  });
  await container.remove().catch((err: any) => {
    if (err.statusCode !== 404) throw err;
  });
}
