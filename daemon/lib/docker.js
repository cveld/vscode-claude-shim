// Docker-touching half of the daemon (docs/plan-launcher-daemon.md, decision 4): talks to
// Docker Desktop via its Windows named pipe through dockerode, never by shelling out to
// `docker` with string-concatenated arguments. No in-memory instance registry — listInstances
// always re-queries `docker ps` by label, so a daemon restart needs no recovery step.

import Docker from 'dockerode';
import crypto from 'node:crypto';
import { claudeHomeMounts } from './claudeHome.js';

const IMAGE = 'vscode-claude-shim:latest';
const MANAGED_LABEL = 'shim.managed';
const CONTAINER_PORT = '8080/tcp';

const docker = new Docker({ socketPath: '//./pipe/docker_engine' });

// Stable per-project id, not a random one: relaunching the same folder/workspace reuses the
// same name and `.claude` volume, so chat history and container-name collisions both behave
// predictably (a second launch of an already-running project fails with a name conflict
// instead of silently spawning a duplicate).
function projectId(rootId, relativePath) {
  const hash = crypto.createHash('sha256').update(relativePath).digest('hex').slice(0, 12);
  return `${rootId}-${hash}`;
}

function toDockerMounts(mounts) {
  return mounts.map((m) => ({
    Type: 'bind',
    Source: m.hostPath,
    Target: m.containerPath,
    ReadOnly: m.mode === 'ro',
  }));
}

function generatePassword() {
  return crypto.randomBytes(9).toString('base64url');
}

export async function createInstance(resolved) {
  const id = projectId(resolved.rootId, resolved.relativePath);
  const name = `shim-${id}`;
  const claudeVolumeName = `shim-claude-${id}`;
  const vscodeConfigVolumeName = `shim-vscode-config-${id}`;

  await docker.createVolume({ Name: claudeVolumeName }).catch((err) => {
    if (err.statusCode !== 409) throw err; // already exists — this is what gives a relaunch its history back.
  });
  await docker.createVolume({ Name: vscodeConfigVolumeName }).catch((err) => {
    if (err.statusCode !== 409) throw err; // same as above, for code-server's own UI state.
  });

  const projectMounts =
    resolved.type === 'workspace'
      ? resolved.folderMounts
      : [{ hostPath: resolved.hostPath, containerPath: '/home/coder/project', mode: 'rw' }];

  const mounts = [
    { Type: 'volume', Source: claudeVolumeName, Target: '/home/coder/.claude' },
    { Type: 'volume', Source: vscodeConfigVolumeName, Target: '/home/coder/.local/share/code-server' },
    ...toDockerMounts(claudeHomeMounts()),
    ...toDockerMounts(projectMounts),
  ];
  if (resolved.type === 'workspace') {
    mounts.push({
      Type: 'bind',
      Source: resolved.workspaceHostFile,
      Target: '/home/coder/workspace.code-workspace',
      ReadOnly: true,
    });
  }
  const cmdTarget = resolved.type === 'workspace' ? '/home/coder/workspace.code-workspace' : '/home/coder/project';
  const password = generatePassword();

  const container = await docker.createContainer({
    name,
    Image: IMAGE,
    Labels: {
      [MANAGED_LABEL]: 'true',
      'shim.rootId': resolved.rootId,
      'shim.relativePath': resolved.relativePath,
      'shim.type': resolved.type,
      'shim.password': password,
      'shim.createdAt': String(Date.now()),
    },
    Cmd: ['--bind-addr', '0.0.0.0:8080', cmdTarget],
    Env: [`PASSWORD=${password}`],
    ExposedPorts: { [CONTAINER_PORT]: {} },
    HostConfig: {
      Mounts: mounts,
      PortBindings: { [CONTAINER_PORT]: [{ HostPort: '' }] },
    },
  });

  await container.start();
  return summarize(await container.inspect());
}

function summarize(info) {
  const labels = info.Config.Labels || {};
  const hostPort = info.NetworkSettings?.Ports?.[CONTAINER_PORT]?.[0]?.HostPort;
  return {
    id: info.Id.slice(0, 12),
    name: info.Name.replace(/^\//, ''),
    rootId: labels['shim.rootId'],
    relativePath: labels['shim.relativePath'],
    type: labels['shim.type'],
    password: labels['shim.password'],
    createdAt: Number(labels['shim.createdAt']),
    port: hostPort ? Number(hostPort) : null,
    state: info.State.Status,
  };
}

export async function listInstances() {
  const containers = await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: [`${MANAGED_LABEL}=true`] }),
  });
  const infos = await Promise.all(containers.map((c) => docker.getContainer(c.Id).inspect()));
  return infos.map(summarize);
}

export async function stopInstance(idOrName) {
  const container = docker.getContainer(idOrName);
  await container.stop().catch((err) => {
    if (err.statusCode !== 304 && err.statusCode !== 404) throw err; // 304 = already stopped
  });
  await container.remove();
}
