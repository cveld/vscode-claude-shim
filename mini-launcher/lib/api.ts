// Thin typed wrappers around the mini-launcher's own API routes (same origin, :4591).
// Standalone — does not depend on the main launcher (:4590) being up; see lib/docker.ts.

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
  /** Subdomain label the proxy reaches this instance by. */
  slug: string;
  /** Stable URL through the Caddy proxy, or null when the proxy cannot serve it right now. */
  proxyUrl: string | null;
};

// ---- Claude session types (returned by our own /api/sessions) ----

export type ClaudeSession = {
  id: string;
  title: string | null;
  firstUserMessage: string | null;
  startedAt: string | null;
  lastActivity: string | null;
  messageCount: number;
  totalTokensBurned: number;
  isActive: boolean;
  instanceUrl: string | null;
  canOpen: boolean;
  openMode: "session-open";
};

export type ClaudeOpenTarget = "editor" | "sidebar";

export type OpenClaudeSessionResult = {
  ok: boolean;
  sessionId: string;
  openUrl: string | null;
  openMode: "session" | "fallback";
  reason?: string;
};

// ---- Error handling ----

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
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

// ---- Pinned instance (own Docker logic, lib/docker.ts — no :4590 dependency) ----

export function getInstance(): Promise<Instance | null> {
  return fetch("/api/instance")
    .then(asJson<{ instance: Instance | null }>)
    .then((body) => body.instance);
}

export function launchInstance(): Promise<Instance> {
  return fetch("/api/launch", { method: "POST" }).then(asJson<Instance>);
}

export async function stopInstance(): Promise<void> {
  const res = await fetch("/api/stop", { method: "POST" });
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
}

// ---- Mini-launcher API (same origin, :4591) ----

export function getClaudeSessions(): Promise<ClaudeSession[]> {
  return fetch("/api/sessions").then(asJson<ClaudeSession[]>);
}

export function openClaudeSession(
  sessionId: string,
  target: ClaudeOpenTarget = "editor",
): Promise<OpenClaudeSessionResult> {
  return fetch("/api/session-open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, target }),
  }).then(asJson<OpenClaudeSessionResult>);
}

// Dock Claude in the side bar (a fresh conversation — the shipped extension cannot resume a
// specific historic session in the side bar; that only works in an editor panel).
export function openClaudeInSidebar(): Promise<OpenClaudeSessionResult> {
  return fetch("/api/session-open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "", target: "sidebar" }),
  }).then(asJson<OpenClaudeSessionResult>);
}
