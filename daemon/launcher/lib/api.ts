// Thin typed wrappers around the daemon's own /api/* endpoints (see
// docs/plan-launcher-daemon.md and ../../server.js for the source of truth on shapes).
// Same-origin fetches only — the launcher UI is served by the same process as the API.

export type Root = { id: string; label: string };

export type BrowseEntry = { name: string; type: "folder" | "workspace" };

export type BrowseResult = {
  rootId: string;
  relativePath: string;
  children: BrowseEntry[];
};

export type ResolveResult = {
  rootId: string;
  relativePath: string;
  hostPath: string;
  containerPath: string;
  type: "folder" | "workspace";
};

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

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  return res.json();
}

export function getRoots(): Promise<Root[]> {
  return fetch("/api/roots").then(asJson<Root[]>);
}

export function browse(rootId: string, relativePath: string): Promise<BrowseResult> {
  const query = new URLSearchParams({ root: rootId, path: relativePath });
  return fetch(`/api/browse?${query}`).then(asJson<BrowseResult>);
}

export type CreateFolderResult = { rootId: string; relativePath: string; name: string };

export function createFolder(rootId: string, relativePath: string, name: string): Promise<CreateFolderResult> {
  return fetch("/api/browse/folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root: rootId, path: relativePath, name }),
  }).then(asJson<CreateFolderResult>);
}

export function resolvePath(raw: string): Promise<ResolveResult> {
  const query = new URLSearchParams({ path: raw });
  return fetch(`/api/resolve?${query}`).then(asJson<ResolveResult>);
}

export function launchByRoot(rootId: string, relativePath: string): Promise<Instance> {
  return fetch("/api/instances", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rootId, relativePath }),
  }).then(asJson<Instance>);
}

export function launchByPath(rawPath: string): Promise<Instance> {
  return fetch("/api/instances", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: rawPath }),
  }).then(asJson<Instance>);
}

export function listInstances(): Promise<Instance[]> {
  return fetch("/api/instances").then(asJson<Instance[]>);
}

export type RecentEntry = {
  rootId: string;
  relativePath: string;
  type: "folder" | "workspace";
  lastLaunchedAt: number;
};

export function getRecent(): Promise<RecentEntry[]> {
  return fetch("/api/recent").then(asJson<RecentEntry[]>);
}

export function getShimSettings(): Promise<Record<string, unknown>> {
  return fetch("/api/shim-settings").then(asJson<Record<string, unknown>>);
}

export async function putShimSettings(settings: unknown): Promise<void> {
  const res = await fetch("/api/shim-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
}

export async function stopInstance(id: string): Promise<void> {
  const res = await fetch(`/api/instances/${id}/stop`, { method: "POST" });
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
}

export { ApiError };
