import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import module from "node:module";
import { createFallbackVsCodeProxy, createShimExtensionContext, createVsCodeApiFacade } from "@/simulator-lib/vscodeApiFacade";
import type { FacadeBuildResult } from "@/simulator-lib/vscodeApiFacade";
import { resolveExtensionRoot } from "@/simulator-lib/extensionPaths";
import { getConfigurationSnapshot, getWorkspaceFolders } from "@/simulator-lib/workspaceHost";
import type { ShimAccessEvent, ShimFailureFrame, ShimSummary } from "@/simulator-lib/api";

const EXTENSION_ROOT = resolveExtensionRoot();
const PACKAGE_JSON_PATH = path.join(EXTENSION_ROOT, "package.json");
const EXTENSION_ENTRY_PATH = path.join(EXTENSION_ROOT, "extension.js");

const nodeRequire = module.createRequire(EXTENSION_ENTRY_PATH);
const ALLOWED_NODE_SPECIFIERS = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "constants",
  "crypto",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "module",
  "net",
  "os",
  "path",
  "process",
  "readline",
  "stream",
  "string_decoder",
  "timers",
  "timers/promises",
  "url",
  "util",
  "vm",
  "zlib",
  "node:assert",
  "node:async_hooks",
  "node:buffer",
  "node:child_process",
  "node:constants",
  "node:crypto",
  "node:events",
  "node:fs",
  "node:fs/promises",
  "node:http",
  "node:http2",
  "node:https",
  "node:module",
  "node:net",
  "node:os",
  "node:path",
  "node:process",
  "node:readline",
  "node:stream",
  "node:string_decoder",
  "node:timers",
  "node:timers/promises",
  "node:url",
  "node:util",
  "node:vm",
  "node:zlib",
]);

const ALLOWED_RELATIVE_PREFIXES = ["./", "../"];

function describeError(error: unknown): string {
  // Errors thrown inside the vm sandbox are cross-realm, so `instanceof Error` is false.
  // Read `stack`/`message` via duck-typing so we keep the stack for those too.
  if (error && typeof error === "object") {
    const maybe = error as { stack?: unknown; message?: unknown };
    if (typeof maybe.stack === "string" && maybe.stack.length > 0) {
      return maybe.stack;
    }
    if (typeof maybe.message === "string" && maybe.message.length > 0) {
      return maybe.message;
    }
  }
  return String(error);
}

function extractErrorStack(error: unknown): string | null {
  if (error && typeof error === "object") {
    const maybe = error as { stack?: unknown };
    if (typeof maybe.stack === "string" && maybe.stack.length > 0) {
      return maybe.stack;
    }
  }
  return null;
}

type ExtensionManifest = {
  version?: string;
  activationEvents?: string[];
  contributes?: {
    configuration?: {
      properties?: Record<string, unknown>;
    };
    commands?: Array<{ command?: string }>;
  };
};

export type ShimState = FacadeBuildResult["state"];

export type ActivationResult = {
  state: ShimState;
  activationAttempted: boolean;
  activationCompleted: boolean;
  activationError: string | null;
  activationFailureKind: ShimSummary["activationFailureKind"];
  activationFailureSummary: string | null;
};

// Build the facade, load and activate the real extension, and resolve its webview views.
// This is the shared core behind both the one-shot `getShimSummary` (driveInit: true, so it
// captures a simulated init reply) and the persistent session in `shimSession.ts`
// (driveInit: false, because a real browser drives the init handshake instead).
export async function activateShim(options: { driveInit?: boolean } = {}): Promise<ActivationResult> {
  const { vscode, state } = createVsCodeApiFacade();
  const recordAccess = (
    kind: ShimAccessEvent["kind"],
    path: string,
    detail?: string,
    extras: Partial<Omit<ShimAccessEvent, "seq" | "kind" | "path" | "detail">> = {},
  ) => {
    const candidate: ShimAccessEvent = {
      seq: state.nextAccessSeq,
      kind,
      path,
      detail,
      ...extras,
    };
    const last = state.accessEvents[state.accessEvents.length - 1];
    if (
      last &&
      last.kind === candidate.kind &&
      last.path === candidate.path &&
      last.detail === candidate.detail &&
      last.source === candidate.source &&
      last.phase === candidate.phase &&
      last.parentSeq === candidate.parentSeq &&
      last.derived === candidate.derived
    ) {
      return last.seq;
    }
    if (state.accessEvents.length >= state.accessEventLimit) {
      state.accessEvents.shift();
      state.accessEventsDropped += 1;
    }
    state.nextAccessSeq += 1;
    state.accessEvents.push(candidate);
    return candidate.seq;
  };
  const wrapCall = <TArgs extends unknown[], TResult>(
    path: string,
    fn: (...args: TArgs) => TResult,
    source: ShimAccessEvent["source"] = path.startsWith("context") ? "context" : "vscode",
    phase: ShimAccessEvent["phase"] = "activation",
  ) => {
    return (...args: TArgs) => {
      const seq = recordAccess("call", path, args.length ? args.map((arg) => safeRender(arg)).join(", ") : undefined, { source, phase });
      try {
        const result = fn(...args);
        if (result === undefined) {
          recordAccess("return-undefined", `${path}(...)`, undefined, { source, phase, parentSeq: seq });
          return result;
        }
        if (result && typeof result === "object" && !(result as { __shimTraceProxy?: boolean }).__shimTraceProxy) {
          return wrapObject(`${path}(...)`, result as Record<string, unknown>, source, "callback") as TResult;
        }
        if (typeof result === "function") {
          return wrapCall(`${path}(...)`, result as (...args: unknown[]) => unknown, source, "callback") as TResult;
        }
        return result;
      } catch (error) {
        recordAccess("throw", path, describeError(error), { source, phase, parentSeq: seq });
        throw error;
      }
    };
  };
  const wrapObject = <T extends Record<string, unknown>>(
    path: string,
    target: T,
    source: ShimAccessEvent["source"] = path.startsWith("context") ? "context" : "vscode",
    phase: ShimAccessEvent["phase"] = "activation",
  ): T => {
    return new Proxy(target, {
      get(innerTarget, property, receiver) {
        if (property === "__shimTraceProxy") {
          return true;
        }
        if (typeof property === "symbol") {
          return Reflect.get(innerTarget, property, receiver);
        }
        const propertyName = String(property);
        const childPath = `${path}.${propertyName}`;
        const seq = recordAccess("get", childPath, undefined, { source, phase });
        const value = Reflect.get(innerTarget, property, receiver);
        if (value === undefined) {
          const detail = propertyName === "error" ? `missing property read from ${path}` : undefined;
          recordAccess("return-undefined", childPath, detail, { source, phase, parentSeq: seq });
          return undefined;
        }
        if (value && typeof value === "object" && !(value as { __shimTraceProxy?: boolean }).__shimTraceProxy) {
          return wrapObject(childPath, value as Record<string, unknown>, source, phase);
        }
        if (typeof value === "function") {
          // Bind to the receiver so built-in methods (e.g. Array.prototype.push) keep their `this`.
          const bound = (value as (...args: unknown[]) => unknown).bind(innerTarget);
          return wrapCall(childPath, bound, source, "callback");
        }
        return value;
      },
    }) as T;
  };
  const contextWrapObject = <T extends Record<string, unknown>>(path: string, target: T) => wrapObject(path, target, "context", "context-build");
  const contextWrapCall = <TArgs extends unknown[], TResult>(path: string, fn: (...args: TArgs) => TResult) => wrapCall(path, fn, "context", "context-build");
  const fallbackRecord = (kind: ShimAccessEvent["kind"], path: string, detail?: string) => recordAccess(kind, path, detail, { source: "fallback", phase: "activation" });
  const vscodeProxy = new Proxy(vscode, {
    get(target, property, receiver) {
      const path = `vscode.${String(property)}`;
      recordAccess("get", path, undefined, { source: "vscode", phase: "activation" });
      if (property === "__esModule") {
        return true;
      }
      if (Reflect.has(target, property)) {
        return Reflect.get(target, property, receiver);
      }
      state.logs.push({ level: "warn", scope: "vscode", message: `missing root property ${String(property)}` });
      return createFallbackVsCodeProxy((level, scope, message) => state.logs.push({ level, scope, message }), fallbackRecord);
    },
  });
  const rootContextKeys = [
    "subscriptions",
    "globalState",
    "workspaceState",
    "secrets",
    "extensionPath",
    "extensionUri",
    "extensionRootUri",
    "extensionDescriptorUri",
    "extensionPackageJsonUri",
    "extensionEntryUri",
    "extensionMainUri",
    "extension",
    "extensionDescriptor",
    "storageUri",
    "globalStorageUri",
    "logUri",
  ];
  recordAccess("get", "context", `rootKeys=${rootContextKeys.join(",")}`, { source: "context", phase: "context-build" });
  const extensionContext = createShimExtensionContext((level, scope, message) => state.logs.push({ level, scope, message }), EXTENSION_ROOT, contextWrapObject, contextWrapCall);
  for (const key of rootContextKeys) {
    if (key in extensionContext) {
      recordAccess("get", `context.${key}`, "root-context member available", { source: "context", phase: "context-build" });
    }
  }

  let activationAttempted = false;
  let activationCompleted = false;
  let activationError: string | null = null;
  let activationFailureKind: ShimSummary["activationFailureKind"] = null;
  let activationFailureSummary: string | null = null;

  try {
    activationAttempted = true;
    const extensionExports = loadExtensionModule(vscodeProxy, state.logs);
    if (extensionExports && typeof extensionExports.activate === "function") {
      extensionExports.activate(extensionContext);
      activationCompleted = true;
      state.logs.push({ level: "info", scope: "activation", message: "activate(...) completed without throwing." });
      // Webview views register synchronously during activate and are resolved immediately;
      // most providers set `webview.html` synchronously, but await any async resolves (bounded)
      // so their captured HTML lands in this summary.
      await settleWithTimeout(state.pendingResolves, 1500);
      // Simulate the webview's `init` request (what the browser bundle posts on boot) so we
      // capture the extension's real host→webview reply into each view's postInitMessages.
      // A persistent session skips this — the real browser sends its own init.
      if (options.driveInit) {
        await driveInitHandshake(state);
      }
    } else {
      activationError = "Extension module did not expose an activate() function.";
      activationFailureKind = "runtime";
      activationFailureSummary = activationError;
      state.logs.push({ level: "warn", scope: "activation", message: activationError });
    }
  } catch (error) {
    activationError = describeError(error);
    activationFailureKind = classifyActivationFailure(activationError);
    activationFailureSummary = summarizeActivationFailure(activationError);
    state.logs.push({ level: "error", scope: "activation", message: activationError });
    const stack = extractErrorStack(error);
    if (stack) {
      state.logs.push({ level: "error", scope: "activation-stack", message: stack });
    }
  }

  const activationStackHint = deriveActivationStackHint(state.logs);
  if (activationStackHint) {
    recordAccess("throw", activationStackHint.path, activationStackHint.detail, { source: "derived", phase: "activation", derived: true });
  }

  return {
    state,
    activationAttempted,
    activationCompleted,
    activationError,
    activationFailureKind,
    activationFailureSummary,
  };
}

// One-shot summary: activate a fresh shim (driving a simulated init handshake so the real
// host→webview reply is captured) and project the resulting state into a ShimSummary.
export async function getShimSummary(): Promise<ShimSummary> {
  const manifest = readManifest();
  const activationEvents = manifest.activationEvents ?? [];
  const configKeys = Object.keys(manifest.contributes?.configuration?.properties ?? {}).sort();
  const commandContributions = (manifest.contributes?.commands ?? [])
    .map((command) => command.command)
    .filter((value): value is string => Boolean(value))
    .sort();

  const activation = await activateShim({ driveInit: true });
  return buildShimSummary(activation, { activationEvents, configKeys, commandContributions, manifestVersion: manifest.version });
}

// Project an ActivationResult into the ShimSummary shape returned by /api/shim-summary.
export function buildShimSummary(
  activation: ActivationResult,
  manifestInfo: {
    activationEvents: string[];
    configKeys: string[];
    commandContributions: string[];
    manifestVersion?: string;
  },
): ShimSummary {
  const { state } = activation;
  return {
    extensionPath: EXTENSION_ENTRY_PATH,
    extensionVersion: manifestInfo.manifestVersion ?? "unknown",
    activationEvents: manifestInfo.activationEvents,
    configKeys: manifestInfo.configKeys,
    commandContributions: manifestInfo.commandContributions,
    commandsRegistered: state.commandInfos,
    viewsRegistered: state.views,
    resolvedViews: state.resolvedViews,
    unsupportedApiCalls: state.unsupportedApiCalls,
    activationAttempted: activation.activationAttempted,
    activationCompleted: activation.activationCompleted,
    activationError: activation.activationError,
    activationFailureKind: activation.activationFailureKind,
    activationFailureSummary: activation.activationFailureSummary,
    diagnostics: buildDiagnostics(activation.activationError, state.accessEvents, state.accessEventsDropped),
    logs: state.logs,
    workspaceFolders: getWorkspaceFolders().map((folder) => folder.uri.fsPath),
    configurationSnapshot: getConfigurationSnapshot(),
  };
}

function buildDiagnostics(
  activationError: string | null,
  accessEvents: ShimAccessEvent[],
  accessEventsDropped: number,
): ShimSummary["diagnostics"] {
  const failureFrames = extractFailureFrames(activationError);
  const suspectedProperty = extractMissingPropertyName(activationError);
  const recentAccesses = summarizeRecentAccesses(accessEvents);
  const candidate = selectFailureCandidate(activationError, accessEvents, failureFrames);
  const correlatedAccesses = buildCorrelatedAccesses(candidate, recentAccesses, suspectedProperty);
  if (!candidate && recentAccesses.length > 0) {
    const last = recentAccesses[recentAccesses.length - 1];
    if (last.source === "context" && last.path !== "context") {
      return {
        likelyFailingPath: last.path,
        likelyFailingReason: suspectedProperty
          ? `Heuristic fallback: ${last.path} was the most recent traced context path before a missing .${suspectedProperty} read.`
          : `Heuristic fallback: ${last.path} was the most recent traced context path because no stronger candidate was captured.`,
        likelyFailingConfidence: "low",
        suspectedProperty: suspectedProperty ?? null,
        evidenceType: "heuristic",
        basePath: last.path,
        recentAccesses,
        correlatedAccesses: [...recentAccesses.slice(-3), { seq: (recentAccesses.at(-1)?.seq ?? 0) + 1, kind: "return-undefined", path: last.path, detail: suspectedProperty ? `Heuristic fallback before .${suspectedProperty} read` : "Fallback from most recent context event", source: "derived", phase: "activation", derived: true, parentSeq: last.seq }],
        failureFrames,
        truncated: accessEventsDropped > 0,
        totalRecorded: accessEvents.length + accessEventsDropped,
      };
    }
  }

  return {
    likelyFailingPath: candidate?.path ?? null,
    likelyFailingReason: candidate?.reason ?? null,
    likelyFailingConfidence: candidate?.confidence ?? null,
    suspectedProperty: suspectedProperty ?? null,
    evidenceType: candidate?.evidenceType ?? null,
    basePath: candidate?.basePath ?? candidate?.path ?? null,
    recentAccesses,
    correlatedAccesses,
    failureFrames,
    truncated: accessEventsDropped > 0,
    totalRecorded: accessEvents.length + accessEventsDropped,
  };
}

function extractMissingPropertyName(message: string | null): string | null {
  return message?.match(/Cannot read properties of undefined \(reading '([^']+)'\)/)?.[1] ?? null;
}

function formatCandidatePath(basePath: string, missingProperty: string | null): string {
  if (!missingProperty || basePath.endsWith(`.${missingProperty}`)) {
    return basePath;
  }
  return `${basePath}.${missingProperty}`;
}

function detectEvidenceType(
  event: ShimAccessEvent,
  missingProperty: string | null,
): "direct" | "correlated" | "heuristic" {
  if (missingProperty && event.path.endsWith(`.${missingProperty}`) && event.kind === "return-undefined") {
    return "direct";
  }
  if (event.kind === "throw" && missingProperty && event.path.includes(missingProperty)) {
    return "direct";
  }
  if (event.kind === "return-undefined" || event.kind === "throw") {
    return missingProperty ? "correlated" : "heuristic";
  }
  return "heuristic";
}

function buildCandidateReason(
  event: ShimAccessEvent,
  basePath: string,
  path: string,
  missingProperty: string | null,
  evidenceType: "direct" | "correlated" | "heuristic",
): string {
  if (evidenceType === "direct") {
    const detail = event.detail ? ` (${event.detail})` : "";
    return `Selected ${path} because traced activation evidence directly reached the missing .${missingProperty} property read${detail}.`;
  }
  if (evidenceType === "correlated") {
    return missingProperty
      ? `Selected ${basePath} because it was the strongest recent undefined-producing path before the missing .${missingProperty} read.`
      : `Selected ${basePath} because it was the strongest recent undefined-producing path during activation.`;
  }
  return missingProperty
    ? `Heuristic only: ${basePath} was the highest-scoring recent activation candidate before the missing .${missingProperty} read.`
    : `Heuristic only: ${basePath} was the highest-scoring recent activation candidate.`;
}

function candidateConfidenceFromScore(score: number, evidenceType: "direct" | "correlated" | "heuristic"): "low" | "medium" | "high" {
  if (evidenceType === "heuristic") {
    return score >= 8 ? "medium" : "low";
  }
  return score >= 11 ? "high" : score >= 7 ? "medium" : "low";
}

function buildDerivedCorrelationEvent(
  seq: number,
  candidatePath: string,
  basePath: string,
  reason: string,
  suspectedProperty: string | null,
  evidenceType: "direct" | "correlated" | "heuristic",
  parentSeq?: number,
): ShimAccessEvent {
  const detail = suspectedProperty
    ? `${evidenceType} evidence: ${basePath} likely resolved undefined before .${suspectedProperty} was read. ${reason}`
    : reason;
  return {
    seq,
    kind: "return-undefined",
    path: candidatePath,
    detail,
    source: "derived",
    phase: "activation",
    derived: true,
    parentSeq,
  };
}

function deriveLikelyFailingPath(message: string | null, accessEvents: ShimAccessEvent[]): string | null {
  return selectFailureCandidate(message, accessEvents, extractFailureFrames(message))?.path ?? null;
}

function augmentAccessEvents(accessEvents: ShimAccessEvent[], activationError: string | null): ShimAccessEvent[] {
  return buildCorrelatedAccesses(
    selectFailureCandidate(activationError, accessEvents, extractFailureFrames(activationError)),
    summarizeRecentAccesses(accessEvents),
    extractMissingPropertyName(activationError),
  );
}



function summarizeActivationFailure(message: string): string {
  const unsupportedRequire = extractMissingImportToken(message);
  if (unsupportedRequire) {
    return `Missing allowed runtime import: ${unsupportedRequire}`;
  }

  const unsupportedApi = message.match(/([A-Za-z0-9_.:]+) is not implemented in vscode-simulator yet\./);
  if (unsupportedApi) {
    return `Missing VS Code API surface: ${unsupportedApi[1]}`;
  }

  const firstErrorLine = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("Error:") || line.startsWith("TypeError:") || line.startsWith("ReferenceError:") || line.startsWith("SyntaxError:"));

  return firstErrorLine ?? message.slice(0, 240);
}

function safeRender(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function deriveActivationStackHint(logs: ShimSummary["logs"]): { path: string; detail: string } | null {
  const stackLog = [...logs].reverse().find((entry) => entry.scope === "activation-stack" && entry.message.includes("\n"));
  if (!stackLog) {
    return null;
  }
  const lines = stackLog.message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const interesting = lines.find((line) => line.startsWith("at ") && !line.includes("extensionHostShim") && !line.includes("node:"));
  if (!interesting) {
    return null;
  }
  return {
    path: "activation.stack",
    detail: `First non-shim stack frame: ${interesting}`,
  };
}

function readManifest(): ExtensionManifest {
  return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8")) as ExtensionManifest;
}

// Post the webview's boot-time `init` request into each resolved view, then wait briefly
// so any asynchronous host reply is captured. The message shape mirrors what the real
// browser bundle sends (`{type:"request",requestId,request:{type:"init"}}`); the extension's
// onDidReceiveMessage handler receives it verbatim, exactly as in real VS Code.
async function driveInitHandshake(state: { viewDispatchers: Map<string, (message: unknown) => void> }): Promise<void> {
  const dispatchers = [...state.viewDispatchers.entries()];
  if (dispatchers.length === 0) {
    return;
  }
  for (const [id, dispatch] of dispatchers) {
    dispatch({ type: "request", requestId: `shim-init-${id}`, request: { type: "init" } });
  }
  // The init handler awaits git repository detection before replying, so allow generous time.
  await new Promise<void>((resolve) => setTimeout(resolve, 3000));
}

// Wait for the given promises to settle, but never block the summary longer than `ms`.
// Async webview resolves may await a host handshake that never completes here.
function settleWithTimeout(promises: Array<Promise<unknown>>, ms: number): Promise<void> {
  if (promises.length === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const timer = setTimeout(finish, ms);
    Promise.allSettled(promises).then(() => {
      clearTimeout(timer);
      finish();
    });
  });
}

function loadExtensionModule(vscode: Record<string, unknown>, logs: ShimSummary["logs"]): Record<string, unknown> {
  const source = fs.readFileSync(EXTENSION_ENTRY_PATH, "utf8");
  const moduleRecord = { exports: {} as Record<string, unknown> };
  const shimConsole = buildShimConsole(logs);
  const shimProcess = buildShimProcess(process, logs);
  const sandbox = {
    module: moduleRecord,
    exports: moduleRecord.exports,
    require: createShimRequire(vscode, logs),
    __dirname: EXTENSION_ROOT,
    __filename: EXTENSION_ENTRY_PATH,
    console: shimConsole,
    process: shimProcess,
    Buffer,
    TextEncoder,
    TextDecoder,
    DOMException,
    // The extension constructs `new AbortController()` in request handlers; without it the
    // handler throws a ReferenceError before its try/catch, silently rejecting the request.
    AbortController,
    AbortSignal,
    URL,
    URLSearchParams,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
  } satisfies Record<string, unknown>;

  let _errorTrapValue: unknown = undefined;
const context = vm.createContext({
    ...sandbox,
    global: sandbox,
    globalThis: sandbox,
    get error() {
      try {
        throw new Error("shim_error_trap");
      } catch (e) {
        const s = e instanceof Error ? e.stack ?? "" : "";
        const frames = s.replace(/\r?\n/g, "\n").split("\n").filter((line: string) => line.trim().startsWith("at ") && !line.includes("extensionHostShim") && !line.includes("node:") && !line.includes("vscode-simulator")).slice(0, 5);
        logs.push({ level: "warn", scope: "error-prop-trap", message: `error property read. Ext frames: ${frames.join(" | ") || "none"}` });
      }
      return _errorTrapValue;
    },
    set error(_v: unknown) { /* noop */ },
  });

  const script = new vm.Script(source, { filename: EXTENSION_ENTRY_PATH });
  try {
    script.runInContext(context);
  } catch (error) {
    const stack = extractErrorStack(error) ?? describeError(error);
    logs.push({ level: "error", scope: "loadmodule-stack", message: stack });
    const lines = stack.replace(/\r?\n/g, "\n").split("\n");
    const extFrames = lines.filter((line: string) => line.trim().startsWith("at ")).slice(0, 10);
    for (const frame of extFrames) {
      logs.push({ level: "error", scope: "activation-frame", message: frame.trim() });
    }
    throw error;
  }

  return moduleRecord.exports;
}

function buildShimConsole(logs: ShimSummary["logs"]): typeof console {
  const origConsole = console;
  const logLevel = (level: ShimSummary["logs"][number]["level"], ...args: unknown[]) => {
    logs.push({ level, scope: "bundle-console", message: args.map((a) => safeRender(a)).join(" ") });
    return undefined;
  };
  return {
    log: (...args: unknown[]) => logLevel("info", ...args),
    info: (...args: unknown[]) => logLevel("info", ...args),
    warn: (...args: unknown[]) => logLevel("warn", ...args),
    error: (...args: unknown[]) => logLevel("error", ...args),
    debug: (...args: unknown[]) => logLevel("info", ...args),
    trace: (...args: unknown[]) => logLevel("info", ...args),
    assert: (...args: unknown[]) => { if (!args[0]) logLevel("error", ...args.slice(1)); },
    clear: () => {},
    count: () => {},
    countReset: () => {},
    dir: () => {},
    dirxml: () => {},
    group: () => {},
    groupCollapsed: () => {},
    groupEnd: () => {},
    table: () => {},
    time: () => {},
    timeEnd: () => {},
    timeLog: () => {},
    timeStamp: () => {},
    profile: () => {},
    profileEnd: () => {},
    Console: origConsole.Console,
  };
}

function buildShimProcess(origProcess: NodeJS.Process, logs: ShimSummary["logs"]): unknown {
  return new Proxy(origProcess, {
    get(target, property, receiver) {
      if (property === "stderr" || property === "stdout") {
        const stream = Reflect.get(target, property, receiver);
        if (stream && typeof stream.write === "function") {
          return new Proxy(stream, {
            get(innerTarget, innerProperty, innerReceiver) {
              if (innerProperty === "write") {
                return (...args: unknown[]) => {
                  logs.push({ level: "info", scope: `bundle-${String(property)}`, message: args.map((a: unknown) => safeRender(a)).join(" ") });
                  return true;
                };
              }
              return Reflect.get(innerTarget, innerProperty, innerReceiver);
            },
          });
        }
      }
      if (property === "exit") {
        return (code?: number) => {
          logs.push({ level: "warn", scope: "bundle-process", message: `process.exit(${code}) called` });
          return origProcess.exit(code);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return value;
    },
  });
}

function createShimRequire(vscode: Record<string, unknown>, logs: ShimSummary["logs"]) {
  let requireCount = 0;
  return (specifier: string) => {
    requireCount++;
    if (specifier === "vscode") {
      return vscode;
    }
    if (!isAllowedRequire(specifier)) {
      throw new Error(`Unsupported require in shim: ${specifier}`);
    }
    let result: unknown;
    try {
      result = nodeRequire(specifier);
    } catch (error) {
      logs.push({ level: "error", scope: "require-fail", message: `#${requireCount} ${specifier}: ${describeError(error)}` });
      throw error;
    }
    if (result === undefined) {
      logs.push({ level: "warn", scope: "require-undefined", message: `#${requireCount} ${specifier} returned undefined` });
    }
    return result;
  };
}

function isAllowedRequire(specifier: string): boolean {
  if (ALLOWED_NODE_SPECIFIERS.has(specifier)) return true;
  if (ALLOWED_RELATIVE_PREFIXES.some((prefix) => specifier.startsWith(prefix))) return true;
  // Allow any genuine Node.js built-in module (covers tls, dns, tty, worker_threads, etc.
  // and their `node:` forms) so the trusted extension bundle can load its dependencies.
  const bare = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
  return module.isBuiltin(bare);
}

function appendLog(logs: ShimSummary["logs"], level: ShimSummary["logs"][number]["level"], scope: string, message: string) {
  logs.push({ level, scope, message });
}

function classifyActivationFailure(message: string): ShimSummary["activationFailureKind"] {
  if (message.includes("Unsupported require in shim:")) {
    return "loader";
  }
  if (message.includes("is not implemented in vscode-simulator yet.")) {
    return "vscode-api";
  }
  if (message.includes("TypeError") || message.includes("ReferenceError") || message.includes("SyntaxError")) {
    return "runtime";
  }
  return "unknown";
}

function extractMissingImportToken(message: string): string | null {
  const directMatch = message.match(/Unsupported require in shim: ([A-Za-z0-9_./:-]+)/);
  if (directMatch) {
    return directMatch[1];
  }

  const lines = message.split(/\r?\n/);
  for (const line of lines) {
    if (!line.includes("Unsupported require in shim:")) continue;
    const tail = line.slice(line.indexOf("Unsupported require in shim:") + "Unsupported require in shim:".length);
    const tokenMatch = tail.match(/[A-Za-z0-9_./:-]+/);
    if (tokenMatch) {
      return tokenMatch[0];
    }
  }

  return null;
}

function summarizeRecentAccesses(accessEvents: ShimAccessEvent[]): ShimAccessEvent[] {
  if (accessEvents.length === 0) {
    return [];
  }

  const tail = accessEvents.slice(-20);
  const filtered = tail.filter((event, index) => {
    if (event.path === "vscode.__esModule") {
      return index === tail.length - 1 && tail.length === 1;
    }
    return true;
  });

  return filtered.length > 0 ? filtered : tail;
}

function extractFailureFrames(message: string | null): ShimFailureFrame[] {
  if (!message) {
    return [];
  }

  return message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .slice(0, 5)
    .map((raw) => {
      const match = raw.match(/^at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?$/);
      const file = match?.[2];
      const functionName = match?.[1];
      const line = match?.[3] ? Number(match[3]) : undefined;
      const column = match?.[4] ? Number(match[4]) : undefined;
      const classification: ShimFailureFrame["classification"] = file?.startsWith(EXTENSION_ROOT)
        ? "extension"
        : file?.includes("vscode-simulator")
          ? "shim"
          : file?.startsWith("node:")
            ? "node"
            : "unknown";
      return { raw, functionName, file, line, column, classification };
    });
}

function selectFailureCandidate(
  activationError: string | null,
  accessEvents: ShimAccessEvent[],
  failureFrames: ShimFailureFrame[],
): {
  path: string;
  basePath: string;
  reason: string;
  confidence: "low" | "medium" | "high";
  evidenceType: "direct" | "correlated" | "heuristic";
  suspectedProperty: string | null;
  seq?: number;
} | null {
  if (accessEvents.length === 0) {
    return null;
  }

  const missingProperty = extractMissingPropertyName(activationError);
  const frameTokens = failureFrames.flatMap((frame) => [frame.functionName, frame.file].filter(Boolean) as string[]).join(" ");

  const scored = accessEvents.map((event) => {
    let score = 0;
    if (event.source === "context") score += 5;
    if (event.kind === "throw") score += 6;
    else if (event.kind === "return-undefined") score += 5;
    else if (event.kind === "unsupported") score += 2;
    else if (event.kind === "call") score += 1;
    if (event.path.startsWith("context.") && event.path !== "context") score += 3;
    if (missingProperty && event.path.endsWith(`.${missingProperty}`)) score += 6;
    else if (missingProperty && event.path.includes(missingProperty)) score += 2;
    const eventRoot = event.path.split(".")[0] ?? "";
    if (frameTokens && frameTokens.includes(eventRoot)) score += 1;
    if (event.derived) score -= 4;
    if (event.kind !== "throw" && event.kind !== "return-undefined") score -= 2;
    if (event.path === "context") score -= 4;
    if (event.path === "vscode.__esModule") score -= 5;
    return { event, score };
  });

  scored.sort((a, b) => b.score - a.score || b.event.seq - a.event.seq);
  const winner = scored[0];
  if (!winner || winner.score <= 0) {
    if (!missingProperty) {
      return null;
    }
    return {
      path: missingProperty,
      basePath: missingProperty,
      reason: `Derived only from activation error text for missing property ${missingProperty}.`,
      confidence: "low",
      evidenceType: "heuristic",
      suspectedProperty: missingProperty,
    };
  }

  const evidenceType = detectEvidenceType(winner.event, missingProperty ?? null);
  const basePath = winner.event.path;
  const path = formatCandidatePath(basePath, missingProperty ?? null);
  const confidence = candidateConfidenceFromScore(winner.score, evidenceType);
  const reason = buildCandidateReason(winner.event, basePath, path, missingProperty ?? null, evidenceType);

  return {
    path,
    basePath,
    reason,
    confidence,
    evidenceType,
    suspectedProperty: missingProperty ?? null,
    seq: winner.event.seq,
  };
}

function buildCorrelatedAccesses(
  candidate: {
    path: string;
    basePath: string;
    reason: string;
    confidence: "low" | "medium" | "high";
    evidenceType: "direct" | "correlated" | "heuristic";
    suspectedProperty: string | null;
    seq?: number;
  } | null,
  recentAccesses: ShimAccessEvent[],
  suspectedProperty: string | null,
): ShimAccessEvent[] {
  if (!candidate || !candidate.seq) {
    return candidate
      ? [...recentAccesses.slice(-4), buildDerivedCorrelationEvent((recentAccesses.at(-1)?.seq ?? 0) + 1, candidate.path, candidate.basePath, candidate.reason, suspectedProperty, candidate.evidenceType)]
      : [];
  }

  const correlated = recentAccesses.filter((event) => event.seq === candidate.seq || event.parentSeq === candidate.seq || candidate.seq === event.parentSeq);
  const windowStart = Math.max(0, recentAccesses.findIndex((event) => event.seq === candidate.seq) - 2);
  const windowSlice = recentAccesses.slice(windowStart, windowStart + 5);
  const merged = [...new Map([...windowSlice, ...correlated].map((event) => [event.seq, event])).values()];
  return [...merged, buildDerivedCorrelationEvent((merged.at(-1)?.seq ?? candidate.seq) + 1, candidate.path, candidate.basePath, candidate.reason, suspectedProperty, candidate.evidenceType, candidate.seq)];
}

function statefulTruncated(accessEvents: ShimAccessEvent[]) {
  return accessEvents.length >= 20;
}

function statefulTotalRecorded(accessEvents: ShimAccessEvent[]) {
  return accessEvents.length;
}

