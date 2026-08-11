// Thin typed wrappers around the simulator's own API routes.

export type Instance = {
  id: string;
  rootId: string;
  relativePath: string;
  hostPath: string;
  type: "folder" | "workspace";
  workspaceFolders: string[];
  state: "stopped" | "starting" | "running" | "error";
  port: number | null;
  pid: number;
  lockFilePath: string | null;
  authTokenPresent: boolean;
  startedAt: string | null;
  lastConnectionAt: string | null;
  lastError: string | null;
  transport: "ws";
};

export type TargetInfo = {
  rootId: string;
  relativePath: string;
  hostPath: string;
  containerPath: string;
  type: "folder" | "workspace";
};

export type Diagnostics = {
  lockFileDir: string;
  transport: string;
  authorizationHeader: string;
  lockFileFields: string[];
  claudeDirWritable: boolean;
  pinnedTargetExists: boolean;
  pinnedTargetInAllowedRoot: boolean;
  runtimeState: string;
  port: number | null;
  pid: number | null;
  lockFilePath: string | null;
  workspaceFolders: string[];
  lastConnectionAt: string | null;
  lastError: string | null;
  notes: string[];
};

export type WebviewTargetInfo = {
  extensionLabel: string;
  assetRoot: string;
  entryScript: string;
  entryStyle: string;
  entryScriptUrl: string;
  entryStyleUrl: string;
};

export type ShimLogEntry = {
  level: "info" | "warn" | "error";
  scope: string;
  message: string;
};

export type ShimAccessEvent = {
  seq: number;
  kind: "get" | "call" | "return-undefined" | "unsupported" | "throw";
  path: string;
  detail?: string;
  source?: "context" | "vscode" | "fallback" | "derived";
  phase?: "activation" | "context-build" | "facade-access" | "callback";
  parentSeq?: number;
  derived?: boolean;
};

export type ShimFailureFrame = {
  raw: string;
  functionName?: string;
  file?: string;
  line?: number;
  column?: number;
  classification: "extension" | "shim" | "node" | "unknown";
};

export type ShimDiagnostics = {
  likelyFailingPath: string | null;
  likelyFailingReason: string | null;
  likelyFailingConfidence: "low" | "medium" | "high" | null;
  suspectedProperty: string | null;
  evidenceType: "direct" | "correlated" | "heuristic" | null;
  basePath: string | null;
  recentAccesses: ShimAccessEvent[];
  correlatedAccesses: ShimAccessEvent[];
  failureFrames: ShimFailureFrame[];
  truncated: boolean;
  totalRecorded: number;
};

export type ShimCommandInfo = {
  id: string;
  registeredVia: "registerCommand" | "registerTextEditorCommand";
};

export type ShimViewInfo = {
  id: string;
  type: "webview-view" | "webview-panel";
  title?: string | null;
};

export type ShimResolvedView = {
  id: string;
  resolved: boolean;
  htmlLength: number;
  html: string;
  postMessageCount: number;
  // Host→webview messages the extension posted during resolveWebviewView, captured
  // structurally (parsed when possible) so the browser bridge can replay the real
  // host contract instead of a hand-crafted stub.
  outboundMessages: unknown[];
  // Host→webview messages the extension posted in response to a simulated webview
  // inbound message (the `init` handshake). Empty until the init drive runs.
  postInitMessages: unknown[];
  error: string | null;
};

export type ShimSummary = {
  extensionPath: string;
  extensionVersion: string;
  activationEvents: string[];
  configKeys: string[];
  commandContributions: string[];
  commandsRegistered: ShimCommandInfo[];
  viewsRegistered: ShimViewInfo[];
  resolvedViews: ShimResolvedView[];
  unsupportedApiCalls: string[];
  activationAttempted: boolean;
  activationCompleted: boolean;
  activationError: string | null;
  activationFailureKind: "loader" | "runtime" | "vscode-api" | "unknown" | null;
  activationFailureSummary: string | null;
  diagnostics: ShimDiagnostics;
  logs: ShimLogEntry[];
  workspaceFolders: string[];
  configurationSnapshot: Record<string, unknown>;
};

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

export function getTarget(): Promise<TargetInfo> {
  return fetch("/api/target").then(asJson<TargetInfo>);
}

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

export function getDiagnostics(): Promise<Diagnostics> {
  return fetch("/api/diagnostics").then(asJson<Diagnostics>);
}

export function getWebviewTarget(): Promise<WebviewTargetInfo> {
  return fetch("/api/webview-target").then(asJson<WebviewTargetInfo>);
}

export type WebviewHostHtml = { viewId: string; html: string };

export function getWebviewHostHtml(viewId: string): Promise<WebviewHostHtml> {
  return fetch(`/api/webview-host-html?viewId=${encodeURIComponent(viewId)}`).then(asJson<WebviewHostHtml>);
}

export function postWebviewMessage(viewId: string, message: unknown): Promise<{ delivered: boolean }> {
  return fetch("/api/webview-message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ viewId, message }),
  }).then(asJson<{ delivered: boolean }>);
}

export function getShimSummary(): Promise<ShimSummary> {
  return fetch("/api/shim-summary").then(asJson<ShimSummary>);
}
