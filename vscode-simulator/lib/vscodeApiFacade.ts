import { getConfigurationSnapshot, getConfigurationValue, getWorkspaceFolders } from "@/simulator-lib/workspaceHost";
import type { ShimAccessEvent, ShimCommandInfo, ShimLogEntry, ShimResolvedView, ShimViewInfo } from "@/simulator-lib/api";

type CommandHandler = (...args: unknown[]) => unknown;

type WebviewViewProvider = {
  resolveWebviewView?: (...args: unknown[]) => unknown;
};

type DisposableLike = { dispose(): void };

export type ShimState = {
  commands: Map<string, CommandHandler>;
  commandInfos: ShimCommandInfo[];
  views: ShimViewInfo[];
  resolvedViews: ShimResolvedView[];
  // Per-view functions that deliver a message into the extension's onDidReceiveMessage
  // listeners, simulating what the browser webview would post (e.g. the `init` request).
  viewDispatchers: Map<string, (message: unknown) => void>;
  // Optional live hook invoked for every host→webview postMessage, in addition to the
  // per-view capture arrays. A persistent session sets this to stream messages to a
  // connected browser; when unset (one-shot summary), only the capture arrays are filled.
  onOutbound?: (viewId: string, message: unknown) => void;
  pendingResolves: Array<Promise<unknown>>;
  unsupportedApiCalls: string[];
  logs: ShimLogEntry[];
  accessEvents: ShimAccessEvent[];
  accessEventLimit: number;
  accessEventsDropped: number;
  nextAccessSeq: number;
};

export type FacadeBuildResult = {
  vscode: Record<string, unknown>;
  state: ShimState;
};

// The real workbench turns a file:// extension URI into a special webview-resource URL. Our
// webview runs same-origin in an <iframe>, so rewrite file:// URIs that point inside the
// extension's resources/ dir (icons/logos delivered at runtime via asset_uris_response —
// getAssetUris() calls asWebviewUri(Uri.file(asAbsolutePath("resources/…")))) to the same-origin
// /resources/ prefix the simulator serves. Non-resource URIs pass through unchanged (webview/*
// assets are handled by the host-HTML rewrite in webview-document.ts).
function rewriteWebviewAssetUri(rendered: string): string {
  const marker = "/resources/";
  const idx = rendered.indexOf(marker);
  if (idx === -1 || !/^file:/i.test(rendered)) return rendered;
  return "/resources/" + rendered.slice(idx + marker.length);
}

export function createVsCodeApiFacade(): FacadeBuildResult {
  const state: ShimState = {
    commands: new Map<string, CommandHandler>(),
    commandInfos: [],
    views: [],
    resolvedViews: [],
    viewDispatchers: new Map<string, (message: unknown) => void>(),
    pendingResolves: [],
    unsupportedApiCalls: [],
    logs: [],
    accessEvents: [],
    accessEventLimit: 80,
    accessEventsDropped: 0,
    nextAccessSeq: 1,
  };

  function log(level: ShimLogEntry["level"], scope: string, message: string) {
    state.logs.push({ level, scope, message });
  }

  function recordAccess(kind: ShimAccessEvent["kind"], path: string, detail?: string) {
    const last = state.accessEvents[state.accessEvents.length - 1];
    if (last && last.kind === kind && last.path === path && last.detail === detail) {
      return;
    }
    if (state.accessEvents.length >= state.accessEventLimit) {
      state.accessEvents.shift();
      state.accessEventsDropped += 1;
    }
    state.accessEvents.push({ seq: state.nextAccessSeq++, kind, path, detail });
  }

  function markUnsupported(name: string) {
    if (!state.unsupportedApiCalls.includes(name)) {
      state.unsupportedApiCalls.push(name);
    }
    recordAccess("unsupported", name, "Not implemented in vscode-simulator yet.");
    log("warn", "unsupported", `${name} is not implemented in vscode-simulator yet.`);
  }

  function traceValue(path: string, value: unknown): unknown {
    if (value === undefined) {
      recordAccess("return-undefined", path);
      return undefined;
    }
    if (typeof value === "function") {
      return value;
    }
    if (!value || typeof value !== "object") {
      return value;
    }
    if ((value as { __shimTraceProxy?: boolean }).__shimTraceProxy) {
      return value;
    }
    // Never proxy a thenable: a Proxy has no [[PromiseState]] internal slot, and our
    // traced `then` is returned unbound, so `promise.then(...)` would throw "incompatible
    // receiver" and reject the caller's chain (this broke the webview send queue). Return
    // native promises untouched.
    if (typeof (value as { then?: unknown }).then === "function") {
      return value;
    }
    return createTracedObject(path, value as Record<string, unknown>);
  }

  function createTracedObject<T extends Record<string, unknown>>(path: string, target: T): T {
    return new Proxy(target, {
      get(innerTarget, property, receiver) {
        if (property === "__shimTraceProxy") {
          return true;
        }
        if (typeof property === "symbol") {
          return Reflect.get(innerTarget, property, receiver);
        }
        const childPath = `${path}.${String(property)}`;
        recordAccess("get", childPath);
        const value = Reflect.get(innerTarget, property, receiver);
        return traceValue(childPath, value);
      },
    }) as T;
  }

  function wrapCall<TArgs extends unknown[], TResult>(path: string, fn: (...args: TArgs) => TResult) {
    return (...args: TArgs) => {
      recordAccess("call", path, args.length ? args.map((arg) => safeRender(arg)).join(", ") : undefined);
      return traceValue(`${path}(...)`, fn(...args)) as TResult;
    };
  }

  function registerDisposable(onDispose: () => void): DisposableLike {
    return createTracedObject("disposable", {
      dispose() {
        onDispose();
      },
    });
  }

  // Build a minimal WebviewView shim so a registered WebviewViewProvider can be resolved.
  // The extension's resolveWebviewView(...) sets `webview.html`; the setter captures that
  // host-produced HTML into `record` so it can be reported and later bridged to the browser.
  function createShimWebviewView(id: string, record: ShimResolvedView) {
    const messageListeners = new Set<(message: unknown) => void>();
    const label = JSON.stringify(id);
    // "resolve" while the extension sets up the view; "init" once we simulate the
    // webview's inbound request, so post-init replies land in a separate bucket.
    let capturePhase: "resolve" | "init" = "resolve";
    // Deliver a simulated webview→host message to every subscribed listener.
    state.viewDispatchers.set(id, (message: unknown) => {
      capturePhase = "init";
      log("info", "webview", `view(${id}).dispatchToHost(${safeRender(message)})`);
      for (const listener of messageListeners) {
        try {
          listener(message);
        } catch (error) {
          record.error = describeFacadeError(error);
          log("error", "webview", `view(${id}) onDidReceiveMessage listener threw: ${record.error}`);
        }
      }
    });
    const webview: Record<string, unknown> = {
      options: {},
      cspSource: "vscode-webview:",
      asWebviewUri: wrapCall(`vscode.webviewView(${label}).webview.asWebviewUri`, (uri: { toString(): string } | string) => {
        const rendered = typeof uri === "string" ? uri : uri?.toString?.() ?? String(uri);
        const rewritten = rewriteWebviewAssetUri(rendered);
        log("info", "webview", `view(${id}).asWebviewUri(${rendered})${rewritten !== rendered ? ` -> ${rewritten}` : ""}`);
        return rewritten;
      }),
      postMessage: wrapCall(`vscode.webviewView(${label}).webview.postMessage`, (message: unknown) => {
        record.postMessageCount += 1;
        // Retain the payload structurally so the browser bridge can replay the real
        // host→webview contract; fall back to the rendered string if it is not cloneable.
        const cloned = cloneMessagePayload(message);
        const bucket = capturePhase === "init" ? record.postInitMessages : record.outboundMessages;
        bucket.push(cloned);
        // Live push to a connected browser session, if one is subscribed.
        state.onOutbound?.(id, cloned);
        log("info", "webview", `view(${id}).postMessage(${safeRender(message)})`);
        return Promise.resolve(true);
      }),
      onDidReceiveMessage: wrapCall(`vscode.webviewView(${label}).webview.onDidReceiveMessage`, (listener: (message: unknown) => void) => {
        messageListeners.add(listener);
        log("info", "webview", `view(${id}).onDidReceiveMessage(subscribed)`);
        return registerDisposable(() => messageListeners.delete(listener));
      }),
    };
    Object.defineProperty(webview, "html", {
      enumerable: true,
      configurable: true,
      get() {
        return record.html;
      },
      set(value: unknown) {
        record.html = typeof value === "string" ? value : String(value);
        record.htmlLength = record.html.length;
        record.resolved = true;
        log("info", "webview", `view(${id}).html set (${record.htmlLength} chars)`);
      },
    });
    return {
      webview,
      viewType: id,
      title: undefined as string | undefined,
      description: undefined as string | undefined,
      badge: undefined,
      visible: true,
      show: wrapCall(`vscode.webviewView(${label}).show`, () => {
        log("info", "webview", `view(${id}).show()`);
      }),
      onDidChangeVisibility: wrapCall(`vscode.webviewView(${label}).onDidChangeVisibility`, () => registerDisposable(() => undefined)),
      onDidDispose: wrapCall(`vscode.webviewView(${label}).onDidDispose`, () => registerDisposable(() => undefined)),
    };
  }

  const commands = createTracedObject("vscode.commands", {
    registerCommand: wrapCall("vscode.commands.registerCommand", (id: string, handler: CommandHandler) => {
      state.commands.set(id, handler);
      state.commandInfos.push({ id, registeredVia: "registerCommand" });
      log("info", "commands", `registerCommand(${id})`);
      return registerDisposable(() => {
        state.commands.delete(id);
        log("info", "commands", `disposeCommand(${id})`);
      });
    }),
    registerTextEditorCommand: wrapCall("vscode.commands.registerTextEditorCommand", (id: string, handler: CommandHandler) => {
      state.commands.set(id, handler);
      state.commandInfos.push({ id, registeredVia: "registerTextEditorCommand" });
      log("info", "commands", `registerTextEditorCommand(${id})`);
      return registerDisposable(() => {
        state.commands.delete(id);
        log("info", "commands", `disposeTextEditorCommand(${id})`);
      });
    }),
    executeCommand: wrapCall("vscode.commands.executeCommand", async (id: string, ...args: unknown[]) => {
      log("info", "commands", `executeCommand(${id})`);
      const command = state.commands.get(id);
      if (!command) {
        // `setContext` only drives VS Code's when-clause context keys, which the shim
        // does not evaluate. Treat it as a benign no-op instead of an unsupported call.
        if (id === "setContext") {
          return undefined;
        }
        markUnsupported(`commands.executeCommand:${id}`);
        return undefined;
      }
      return command(...args);
    }),
  });

  const window = createTracedObject("vscode.window", {
    createOutputChannel: wrapCall("vscode.window.createOutputChannel", (name: string, options?: { log?: boolean } | string) => {
      log("info", "window", `createOutputChannel(${name}${options ? `, ${safeRender(options)}` : ""})`);
      const channelPath = `vscode.window.createOutputChannel(${JSON.stringify(name)})`;
      return createTracedObject(channelPath, {
        name,
        logLevel: typeof options === "object" && options?.log ? "info" : undefined,
        appendLine: wrapCall(`${channelPath}.appendLine`, (value: string) => {
          log("info", `output:${name}`, value);
        }),
        append: wrapCall(`${channelPath}.append`, (value: string) => {
          log("info", `output:${name}`, value);
        }),
        replace: wrapCall(`${channelPath}.replace`, (value: string) => {
          log("info", `output:${name}`, value);
        }),
        error: wrapCall(`${channelPath}.error`, (value: string) => {
          log("error", `output:${name}`, value);
        }),
        warn: wrapCall(`${channelPath}.warn`, (value: string) => {
          log("warn", `output:${name}`, value);
        }),
        info: wrapCall(`${channelPath}.info`, (value: string) => {
          log("info", `output:${name}`, value);
        }),
        debug: wrapCall(`${channelPath}.debug`, (value: string) => {
          log("info", `output:${name}`, value);
        }),
        trace: wrapCall(`${channelPath}.trace`, (value: string) => {
          log("info", `output:${name}`, value);
        }),
        clear: wrapCall(`${channelPath}.clear`, () => {
          log("info", "window", `clearOutputChannel(${name})`);
        }),
        show: wrapCall(`${channelPath}.show`, () => {
          log("info", "window", `showOutputChannel(${name})`);
        }),
        hide: wrapCall(`${channelPath}.hide`, () => {
          log("info", "window", `hideOutputChannel(${name})`);
        }),
        dispose: wrapCall(`${channelPath}.dispose`, () => {
          log("info", "window", `disposeOutputChannel(${name})`);
        }),
        onDidChangeLogLevel: wrapCall(`${channelPath}.onDidChangeLogLevel`, () => {
          log("info", `output:${name}`, "onDidChangeLogLevel(subscribed)");
          return registerDisposable(() => {
            log("info", `output:${name}`, "disposeLogLevelSubscription()");
          });
        }),
      });
    }),
    registerWebviewViewProvider: wrapCall("vscode.window.registerWebviewViewProvider", (id: string, provider: WebviewViewProvider) => {
      state.views.push({ id, type: "webview-view", title: null });
      log("info", "window", `registerWebviewViewProvider(${id})`);
      const record: ShimResolvedView = { id, resolved: false, htmlLength: 0, html: "", postMessageCount: 0, outboundMessages: [], postInitMessages: [], error: null };
      state.resolvedViews.push(record);
      if (typeof provider?.resolveWebviewView === "function") {
        log("info", "window", `resolving webview view ${id} against shim WebviewView`);
        const webviewView = createShimWebviewView(id, record);
        const resolveContext = { state: undefined };
        const token = {
          isCancellationRequested: false,
          onCancellationRequested: wrapCall(`vscode.webviewView(${JSON.stringify(id)}).token.onCancellationRequested`, () => registerDisposable(() => undefined)),
        };
        try {
          const result = provider.resolveWebviewView(webviewView, resolveContext, token);
          if (result && typeof (result as { then?: unknown }).then === "function") {
            state.pendingResolves.push(
              Promise.resolve(result)
                .then(() => {
                  record.resolved = true;
                })
                .catch((error) => {
                  record.error = describeFacadeError(error);
                  log("error", "webview", `resolveWebviewView(${id}) rejected: ${record.error}`);
                }),
            );
          } else {
            record.resolved = true;
          }
        } catch (error) {
          record.error = describeFacadeError(error);
          log("error", "webview", `resolveWebviewView(${id}) threw: ${record.error}`);
        }
      }
      return registerDisposable(() => {
        log("info", "window", `disposeWebviewViewProvider(${id})`);
      });
    }),
    createWebviewPanel: wrapCall("vscode.window.createWebviewPanel", (viewType: string, title: string) => {
      state.views.push({ id: viewType, type: "webview-panel", title });
      log("info", "window", `createWebviewPanel(${viewType}, ${title})`);
      const listeners = new Set<(message: unknown) => void>();
      return createTracedObject(`vscode.window.createWebviewPanel(${JSON.stringify(viewType)}, ${JSON.stringify(title)})`, {
        viewType,
        title,
        webview: createTracedObject(`vscode.window.createWebviewPanel(${JSON.stringify(viewType)}, ${JSON.stringify(title)}).webview`, {
          html: "",
          options: {},
          postMessage: wrapCall(`vscode.window.createWebviewPanel(${JSON.stringify(viewType)}, ${JSON.stringify(title)}).webview.postMessage`, (message: unknown) => {
            log("info", "webview", `panel.postMessage(${safeRender(message)})`);
            return Promise.resolve(true);
          }),
          onDidReceiveMessage: wrapCall(`vscode.window.createWebviewPanel(${JSON.stringify(viewType)}, ${JSON.stringify(title)}).webview.onDidReceiveMessage`, (listener: (message: unknown) => void) => {
            listeners.add(listener);
            log("info", "webview", `panel.onDidReceiveMessage(${viewType})`);
            return registerDisposable(() => listeners.delete(listener));
          }),
          asWebviewUri: wrapCall(`vscode.window.createWebviewPanel(${JSON.stringify(viewType)}, ${JSON.stringify(title)}).webview.asWebviewUri`, (uri: { toString(): string } | string) => {
            const rendered = typeof uri === "string" ? uri : uri.toString();
            const rewritten = rewriteWebviewAssetUri(rendered);
            log("info", "webview", `asWebviewUri(${rendered})${rewritten !== rendered ? ` -> ${rewritten}` : ""}`);
            return rewritten;
          }),
        }),
        reveal: wrapCall(`vscode.window.createWebviewPanel(${JSON.stringify(viewType)}, ${JSON.stringify(title)}).reveal`, () => {
          log("info", "window", `panel.reveal(${viewType})`);
        }),
        dispose: wrapCall(`vscode.window.createWebviewPanel(${JSON.stringify(viewType)}, ${JSON.stringify(title)}).dispose`, () => {
          log("info", "window", `panel.dispose(${viewType})`);
        }),
      });
    }),
    withProgress: wrapCall("vscode.window.withProgress", (_options: unknown, task: (...args: unknown[]) => unknown) => {
      log("info", "window", "withProgress(...)");
      return Promise.resolve(task({ report() {} }, { isCancellationRequested: false }));
    }),
    createStatusBarItem: wrapCall("vscode.window.createStatusBarItem", () => {
      log("info", "window", "createStatusBarItem()");
      return createTracedObject("vscode.window.createStatusBarItem()", {
        text: "",
        show: wrapCall("vscode.window.createStatusBarItem().show", () => {
          log("info", "window", "statusBar.show()");
        }),
        hide: wrapCall("vscode.window.createStatusBarItem().hide", () => {
          log("info", "window", "statusBar.hide()");
        }),
        dispose: wrapCall("vscode.window.createStatusBarItem().dispose", () => {
          log("info", "window", "statusBar.dispose()");
        }),
      });
    }),
    createTerminal: wrapCall("vscode.window.createTerminal", () => {
      markUnsupported("window.createTerminal");
      return createTracedObject("vscode.window.createTerminal()", {
        show: wrapCall("vscode.window.createTerminal().show", () => {
          log("warn", "terminal", "show() on unsupported terminal stub");
        }),
      });
    }),
    showInformationMessage: wrapCall("vscode.window.showInformationMessage", (message: string) => {
      log("info", "window", `showInformationMessage(${message})`);
      return Promise.resolve(undefined);
    }),
    showErrorMessage: wrapCall("vscode.window.showErrorMessage", (message: string) => {
      log("error", "window", `showErrorMessage(${message})`);
      return Promise.resolve(undefined);
    }),
    activeTextEditor: undefined,
    visibleTextEditors: [],
    activeColorTheme: { kind: 2 },
    state: { focused: true, active: true },
    tabGroups: createTracedObject("vscode.window.tabGroups", {
      all: [],
      activeTabGroup: { tabs: [], isActive: true, viewColumn: 1 },
      onDidChangeTabs: wrapCall("vscode.window.tabGroups.onDidChangeTabs", () => registerDisposable(() => undefined)),
      onDidChangeTabGroups: wrapCall("vscode.window.tabGroups.onDidChangeTabGroups", () => registerDisposable(() => undefined)),
      close: wrapCall("vscode.window.tabGroups.close", () => Promise.resolve(true)),
    }),
    onDidChangeVisibleTextEditors: wrapCall("vscode.window.onDidChangeVisibleTextEditors", () => registerDisposable(() => undefined)),
    onDidChangeActiveTextEditor: wrapCall("vscode.window.onDidChangeActiveTextEditor", () => registerDisposable(() => undefined)),
    onDidChangeTextEditorSelection: wrapCall("vscode.window.onDidChangeTextEditorSelection", () => registerDisposable(() => undefined)),
    onDidChangeTextEditorVisibleRanges: wrapCall("vscode.window.onDidChangeTextEditorVisibleRanges", () => registerDisposable(() => undefined)),
    onDidChangeTextEditorViewColumn: wrapCall("vscode.window.onDidChangeTextEditorViewColumn", () => registerDisposable(() => undefined)),
    onDidChangeWindowState: wrapCall("vscode.window.onDidChangeWindowState", () => registerDisposable(() => undefined)),
    onDidChangeActiveColorTheme: wrapCall("vscode.window.onDidChangeActiveColorTheme", () => registerDisposable(() => undefined)),
    onDidChangeVisibleNotebookEditors: wrapCall("vscode.window.onDidChangeVisibleNotebookEditors", () => registerDisposable(() => undefined)),
    onDidChangeActiveNotebookEditor: wrapCall("vscode.window.onDidChangeActiveNotebookEditor", () => registerDisposable(() => undefined)),
    onDidChangeTextEditorOptions: wrapCall("vscode.window.onDidChangeTextEditorOptions", () => registerDisposable(() => undefined)),
    onDidChangeTerminalState: wrapCall("vscode.window.onDidChangeTerminalState", () => registerDisposable(() => undefined)),
    onDidOpenTerminal: wrapCall("vscode.window.onDidOpenTerminal", () => registerDisposable(() => undefined)),
    onDidCloseTerminal: wrapCall("vscode.window.onDidCloseTerminal", () => registerDisposable(() => undefined)),
    onDidChangeActiveTerminal: wrapCall("vscode.window.onDidChangeActiveTerminal", () => registerDisposable(() => undefined)),
    showWarningMessage: wrapCall("vscode.window.showWarningMessage", (message: string) => {
      log("warn", "window", `showWarningMessage(${message})`);
      return Promise.resolve(undefined);
    }),
    registerWebviewPanelSerializer: wrapCall("vscode.window.registerWebviewPanelSerializer", (viewType: string) => {
      log("info", "window", `registerWebviewPanelSerializer(${viewType})`);
      return registerDisposable(() => undefined);
    }),
    registerUriHandler: wrapCall("vscode.window.registerUriHandler", () => registerDisposable(() => undefined)),
    registerTerminalLinkProvider: wrapCall("vscode.window.registerTerminalLinkProvider", () => registerDisposable(() => undefined)),
    createTextEditorDecorationType: wrapCall("vscode.window.createTextEditorDecorationType", () => createTracedObject("vscode.window.createTextEditorDecorationType()", {
      dispose: wrapCall("vscode.window.createTextEditorDecorationType().dispose", () => undefined),
    })),
  });

  const workspace = createTracedObject("vscode.workspace", {
    workspaceFolders: traceValue("vscode.workspace.workspaceFolders", getWorkspaceFolders()),
    getConfiguration: wrapCall("vscode.workspace.getConfiguration", (section?: string) => {
      log("info", "workspace", `getConfiguration(${section ?? ""})`);
      if (!section) {
        return createTracedObject("vscode.workspace.getConfiguration()", buildConfigurationAccessor(getConfigurationSnapshot()));
      }
      return createTracedObject(`vscode.workspace.getConfiguration(${JSON.stringify(section)})`, {
        get: wrapCall(`vscode.workspace.getConfiguration(${JSON.stringify(section)}).get`, (key?: string, defaultValue?: unknown) => {
          if (!key) {
            return getConfigurationValue(section) ?? defaultValue;
          }
          const composite = `${section}.${key}`;
          const value = getConfigurationValue(composite);
          return value === undefined ? defaultValue : value;
        }),
        has: wrapCall(`vscode.workspace.getConfiguration(${JSON.stringify(section)}).has`, (key: string) => {
          return getConfigurationValue(`${section}.${key}`) !== undefined;
        }),
        inspect: wrapCall(`vscode.workspace.getConfiguration(${JSON.stringify(section)}).inspect`, (key: string) => {
          const composite = `${section}.${key}`;
          const value = getConfigurationValue(composite);
          return createTracedObject(`vscode.workspace.getConfiguration(${JSON.stringify(section)}).inspect(${JSON.stringify(key)})`, {
            key: composite,
            defaultValue: undefined,
            globalValue: value,
            workspaceValue: undefined,
            workspaceFolderValue: undefined,
          });
        }),
        update: wrapCall(`vscode.workspace.getConfiguration(${JSON.stringify(section)}).update`, (key: string, _value?: unknown, _target?: unknown) => {
          log("info", "workspace", `getConfiguration(${section}).update(${key})`);
          return Promise.resolve();
        }),
      });
    }),
    onDidChangeWorkspaceFolders: wrapCall("vscode.workspace.onDidChangeWorkspaceFolders", () => {
      log("info", "workspace", "onDidChangeWorkspaceFolders(subscribed)");
      return registerDisposable(() => undefined);
    }),
    onDidChangeConfiguration: wrapCall("vscode.workspace.onDidChangeConfiguration", () => {
      log("info", "workspace", "onDidChangeConfiguration(subscribed)");
      return registerDisposable(() => undefined);
    }),
    registerFileSystemProvider: wrapCall("vscode.workspace.registerFileSystemProvider", (scheme: string) => {
      log("info", "workspace", `registerFileSystemProvider(${scheme})`);
      return registerDisposable(() => undefined);
    }),
    registerTextDocumentContentProvider: wrapCall("vscode.workspace.registerTextDocumentContentProvider", (scheme: string) => {
      log("info", "workspace", `registerTextDocumentContentProvider(${scheme})`);
      return registerDisposable(() => undefined);
    }),
    createFileSystemWatcher: wrapCall("vscode.workspace.createFileSystemWatcher", (glob: string) => {
      log("info", "workspace", `createFileSystemWatcher(${safeRender(glob)})`);
      return createTracedObject("vscode.workspace.createFileSystemWatcher()", {
        onDidCreate: wrapCall("vscode.workspace.createFileSystemWatcher().onDidCreate", () => registerDisposable(() => undefined)),
        onDidChange: wrapCall("vscode.workspace.createFileSystemWatcher().onDidChange", () => registerDisposable(() => undefined)),
        onDidDelete: wrapCall("vscode.workspace.createFileSystemWatcher().onDidDelete", () => registerDisposable(() => undefined)),
        dispose: wrapCall("vscode.workspace.createFileSystemWatcher().dispose", () => undefined),
      });
    }),
    onDidOpenTextDocument: wrapCall("vscode.workspace.onDidOpenTextDocument", () => registerDisposable(() => undefined)),
    onDidCloseTextDocument: wrapCall("vscode.workspace.onDidCloseTextDocument", () => registerDisposable(() => undefined)),
    onDidChangeTextDocument: wrapCall("vscode.workspace.onDidChangeTextDocument", () => registerDisposable(() => undefined)),
    onDidSaveTextDocument: wrapCall("vscode.workspace.onDidSaveTextDocument", () => registerDisposable(() => undefined)),
    onWillSaveTextDocument: wrapCall("vscode.workspace.onWillSaveTextDocument", () => registerDisposable(() => undefined)),
  });

  const env = createTracedObject("vscode.env", {
    appName: "VS Code Simulator",
  });

  const authentication = createTracedObject("vscode.authentication", {
    getSession: wrapCall("vscode.authentication.getSession", () => {
      markUnsupported("authentication.getSession");
      return Promise.resolve(undefined);
    }),
  });

  const extensions = createTracedObject("vscode.extensions", {
    getExtension: wrapCall("vscode.extensions.getExtension", () => {
      markUnsupported("extensions.getExtension");
      return undefined;
    }),
  });

  const Uri = createTracedObject("vscode.Uri", {
    file: wrapCall("vscode.Uri.file", (path: string) => {
      return buildShimUri(`vscode.Uri.file(${JSON.stringify(path)})`, path, createTracedObject, wrapCall);
    }),
    joinPath: wrapCall("vscode.Uri.joinPath", (base: { fsPath?: string; path?: string }, ...parts: string[]) => {
      const basePath = typeof base?.fsPath === "string" ? base.fsPath : typeof base?.path === "string" ? base.path.replace(/^\//, "").replace(/\//g, "\\") : "";
      const joinedPath = [basePath, ...parts].filter(Boolean).join("\\");
      return buildShimUri(`vscode.Uri.joinPath(${JSON.stringify(joinedPath)})`, joinedPath, createTracedObject, wrapCall);
    }),
    parse: wrapCall("vscode.Uri.parse", (value: string) => {
      if (value.startsWith("file:///")) {
        return buildShimUri(`vscode.Uri.parse(${JSON.stringify(value)})`, value.replace(/^file:\/\//, "").replace(/^\//, "").replace(/\//g, "\\"), createTracedObject, wrapCall);
      }
      return createTracedObject(`vscode.Uri.parse(${JSON.stringify(value)})`, {
        scheme: value.split(":", 1)[0] || "file",
        authority: "",
        path: value.includes("://") ? value.slice(value.indexOf("://") + 3) : value,
        query: "",
        fragment: "",
        fsPath: value,
        toString: wrapCall(`vscode.Uri.parse(${JSON.stringify(value)}).toString`, () => value),
      });
    }),
    revive: wrapCall("vscode.Uri.revive", (data: { fsPath?: string; path?: string; scheme?: string; authority?: string; query?: string; fragment?: string }) => {
      if (typeof data?.fsPath === "string") {
        return buildShimUri("vscode.Uri.revive", data.fsPath, createTracedObject, wrapCall);
      }
      if (typeof data?.path === "string") {
        return createTracedObject("vscode.Uri.revive", {
          scheme: data.scheme ?? "file",
          authority: data.authority ?? "",
          path: data.path,
          query: data.query ?? "",
          fragment: data.fragment ?? "",
          fsPath: data.path.replace(/^\//, "").replace(/\//g, "\\"),
          toString: wrapCall("vscode.Uri.revive.toString", () => `${data.scheme ?? "file"}://${data.path}`),
        });
      }
      return undefined;
    }),
  });

  const makeNotebookCellOutputItem = (mime: string, value: unknown) =>
    createTracedObject(`vscode.NotebookCellOutputItem(${JSON.stringify(mime)})`, {
      mime,
      data: value instanceof Uint8Array ? value : new TextEncoder().encode(typeof value === "string" ? value : safeRender(value)),
    });
  const NotebookCellOutputItem = createTracedObject("vscode.NotebookCellOutputItem", {
    error: wrapCall("vscode.NotebookCellOutputItem.error", (err: unknown) => {
      const rendered = err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err;
      return makeNotebookCellOutputItem("application/vnd.code.notebook.error", rendered);
    }),
    text: wrapCall("vscode.NotebookCellOutputItem.text", (value: string, mime: string = "text/plain") => makeNotebookCellOutputItem(mime, value)),
    json: wrapCall("vscode.NotebookCellOutputItem.json", (value: unknown, mime: string = "application/json") => makeNotebookCellOutputItem(mime, safeRender(value))),
    stdout: wrapCall("vscode.NotebookCellOutputItem.stdout", (value: string) => makeNotebookCellOutputItem("application/vnd.code.notebook.stdout", value)),
    stderr: wrapCall("vscode.NotebookCellOutputItem.stderr", (value: string) => makeNotebookCellOutputItem("application/vnd.code.notebook.stderr", value)),
  });

  const vscode = createTracedObject("vscode", {
    __esModule: true,
    default: undefined,
    error: undefined,
    warn: undefined,
    info: undefined,
    debug: undefined,
    trace: undefined,
    log: undefined,
    logger: undefined,
    outputChannel: undefined,
    envVariableCollection: undefined,
    version: "0.0-shim",
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { Notification: 15, Window: 10 },
    ViewColumn: { One: 1, Two: 2, Three: 3, Active: -1, Beside: -2 },
    LogLevel: { Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5, Off: 6 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    Disposable: {
      from: (...items: Array<{ dispose(): void }>) => ({
        dispose() {
          for (const item of items) {
            item?.dispose?.();
          }
        },
      }),
    },
    EventEmitter: class<T = unknown> {
      private listeners = new Set<(value: T) => void>();
      event = (listener: (value: T) => void) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      };
      fire(value: T) {
        for (const listener of this.listeners) {
          listener(value);
        }
      }
      dispose() {
        this.listeners.clear();
      }
    },
    Position: class Position {
      constructor(public line: number, public character: number) {}
    },
    Range: class Range {
      constructor(
        public startLine: number,
        public startCharacter: number,
        public endLine: number,
        public endCharacter: number,
      ) {}
    },
    Selection: class Selection {
      constructor(
        public anchorLine: number,
        public anchorCharacter: number,
        public activeLine: number,
        public activeCharacter: number,
      ) {}
    },
    ThemeIcon: class ThemeIcon {
      constructor(public id: string) {}
    },
    MarkdownString: class MarkdownString {
      value: string;
      isTrusted = false;
      supportHtml = false;
      constructor(value = "") {
        this.value = value;
      }
      appendMarkdown(value: string) {
        this.value += value;
        return this;
      }
      appendText(value: string) {
        this.value += value;
        return this;
      }
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    commands,
    window,
    workspace,
    env,
    authentication,
    extensions,
    Uri,
    NotebookCellOutputItem,
  });

  return { vscode, state };
}

function buildConfigurationAccessor(snapshot: Record<string, unknown>) {
  return {
    get(key: string, defaultValue?: unknown) {
      return key in snapshot ? snapshot[key] : defaultValue;
    },
    has(key: string) {
      return key in snapshot;
    },
  };
}

function createLoggingProxy(
  scope: string,
  log: (level: ShimLogEntry["level"], scope: string, message: string) => void,
  trace?: (kind: ShimAccessEvent["kind"], path: string, detail?: string) => void,
) {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (property === Symbol.toStringTag) return "LoggingProxy";
        if (typeof property === "symbol") {
          return undefined;
        }
        const path = `${scope}.${String(property)}`;
        trace?.("get", path);
        return (...args: unknown[]) => {
          const renderedArgs = args.map((arg) => safeRender(arg)).join(", ");
          trace?.("call", path, renderedArgs || undefined);
          log("warn", scope, `${String(property)}(${renderedArgs})`);
          trace?.("return-undefined", `${path}(...)`);
          return undefined;
        };
      },
    },
  );
}

function buildShimUri(
  path: string,
  fsPath: string,
  traceObject: <T extends Record<string, unknown>>(path: string, target: T) => T,
  traceNestedCall: <TArgs extends unknown[], TResult>(path: string, fn: (...args: TArgs) => TResult) => (...args: TArgs) => TResult,
): Record<string, unknown> {
  const normalizedPath = fsPath.replace(/\\/g, "/");
  const uriPath = normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`;

  return buildShimUriFromParts(path, {
    scheme: "file",
    authority: "",
    path: uriPath,
    query: "",
    fragment: "",
    fsPath,
  }, traceObject, traceNestedCall);
}

function buildShimUriFromParts(
  path: string,
  uri: {
    scheme: string;
    authority: string;
    path: string;
    query: string;
    fragment: string;
    fsPath: string;
  },
  traceObject: <T extends Record<string, unknown>>(path: string, target: T) => T,
  traceNestedCall: <TArgs extends unknown[], TResult>(path: string, fn: (...args: TArgs) => TResult) => (...args: TArgs) => TResult,
): Record<string, unknown> {
  const renderUri = () => {
    const authorityPart = uri.authority ? `//${uri.authority}` : "//";
    const queryPart = uri.query ? `?${uri.query}` : "";
    const fragmentPart = uri.fragment ? `#${uri.fragment}` : "";
    return `${uri.scheme}:${authorityPart}${uri.path}${queryPart}${fragmentPart}`;
  };
  const applyChanges = (change: Partial<Omit<typeof uri, "fsPath">> & { fsPath?: string }) => {
    const nextScheme = change.scheme ?? uri.scheme;
    const nextAuthority = change.authority ?? uri.authority;
    const nextQuery = change.query ?? uri.query;
    const nextFragment = change.fragment ?? uri.fragment;
    const nextPathInput = change.path ?? uri.path;
    const nextPath = nextPathInput.replace(/\\/g, "/");
    const normalizedPath = nextPath.startsWith("/") ? nextPath : `/${nextPath}`;
    const nextFsPath = change.fsPath ?? (nextScheme === "file" ? normalizedPath.replace(/^\//, "").replace(/\//g, "\\") : uri.fsPath);
    return buildShimUriFromParts(path, {
      scheme: nextScheme,
      authority: nextAuthority,
      path: normalizedPath,
      query: nextQuery,
      fragment: nextFragment,
      fsPath: nextFsPath,
    }, traceObject, traceNestedCall);
  };

  return traceObject(path, {
    scheme: uri.scheme,
    authority: uri.authority,
    path: uri.path,
    query: uri.query,
    fragment: uri.fragment,
    fsPath: uri.fsPath,
    toString: traceNestedCall(`${path}.toString`, (_skipEncoding?: boolean) => {
      return renderUri();
    }),
    toJSON: traceNestedCall(`${path}.toJSON`, () => {
      return {
        $mid: 1,
        scheme: uri.scheme,
        authority: uri.authority,
        path: uri.path,
        query: uri.query,
        fragment: uri.fragment,
        fsPath: uri.fsPath,
      };
    }),
    with: traceNestedCall(`${path}.with`, (change: Partial<Omit<typeof uri, "fsPath">> & { fsPath?: string }) => {
      return applyChanges(change ?? {});
    }),
  });
}

function createMemento(
  log: (level: ShimLogEntry["level"], scope: string, message: string) => void,
  scope: string,
  traceObject: <T extends Record<string, unknown>>(path: string, target: T) => T,
  traceNestedCall: <TArgs extends unknown[], TResult>(path: string, fn: (...args: TArgs) => TResult) => (...args: TArgs) => TResult,
) {
  const values = new Map<string, unknown>();
  return traceObject(scope, {
    get: traceNestedCall(`${scope}.get`, <T>(key: string, defaultValue?: T): T | undefined => {
      return (values.has(key) ? values.get(key) : defaultValue) as T | undefined;
    }),
    update: traceNestedCall(`${scope}.update`, (key: string, value: unknown) => {
      values.set(key, value);
      log("info", scope, `update(${key})`);
      return Promise.resolve();
    }),
  });
}

export function createShimExtensionContext(
  log: (level: ShimLogEntry["level"], scope: string, message: string) => void,
  extensionRoot: string,
  traceObject: <T extends Record<string, unknown>>(path: string, target: T) => T,
  traceNestedCall: <TArgs extends unknown[], TResult>(path: string, fn: (...args: TArgs) => TResult) => (...args: TArgs) => TResult,
) {
  const extensionPathNormalized = extensionRoot.replace(/\\/g, "/");
  const packageJsonPath = `${extensionRoot}\\package.json`;
  const extensionEntryPath = `${extensionRoot}\\extension.js`;
  const makeUri = (path: string, fsPath: string) => traceObject(path, buildShimUri(path, fsPath, traceObject, traceNestedCall));
  const makeFileUri = (path: string, relativeSuffix: string) => makeUri(path, `${extensionRoot}\\${relativeSuffix}`);
  const extensionUri = makeUri("context.extensionUri", extensionRoot);
  const extensionRootUri = makeUri("context.extensionRootUri", extensionRoot);
  const extensionDescriptorUri = makeUri("context.extensionDescriptorUri", packageJsonPath);
  const extensionPackageJsonUri = makeUri("context.extensionPackageJsonUri", packageJsonPath);
  const extensionEntryUri = makeUri("context.extensionEntryUri", extensionEntryPath);
  const extensionMainUri = makeUri("context.extensionMainUri", extensionEntryPath);
  const extensionPackageJson = traceObject("context.extensionPackageJson", {
    name: "claude-code",
    publisher: "Anthropic",
    displayName: "Claude Code",
    version: "2.1.209",
    main: "./extension.js",
  });
  const extensionExports = traceObject("context.extensionExports", {});
  const extensionMetadata = traceObject("context.extensionMetadata", {
    id: "Anthropic.claude-code",
    version: "2.1.209",
    publisher: "Anthropic",
  });
  const extension = traceObject("context.extension", {
    id: extensionMetadata.id,
    extensionPath: extensionRoot,
    extensionUri: makeUri("context.extension.extensionUri", extensionRoot),
    packageJSON: traceObject("context.extension.packageJSON", {
      name: extensionPackageJson.name,
      publisher: extensionPackageJson.publisher,
      displayName: extensionPackageJson.displayName,
      version: extensionPackageJson.version,
      main: extensionPackageJson.main,
    }),
    exports: extensionExports,
    isActive: true,
    extensionKind: 1,
  });
  const extensionDescriptor = traceObject("context.extensionDescriptor", {
    extensionPath: extensionRoot,
    extensionUri: makeUri("context.extensionDescriptor.extensionUri", extensionRoot),
    packageJSON: traceObject("context.extensionDescriptor.packageJSON", {
      name: extensionPackageJson.name,
      publisher: extensionPackageJson.publisher,
      displayName: extensionPackageJson.displayName,
      version: extensionPackageJson.version,
      main: extensionPackageJson.main,
    }),
    id: extensionMetadata.id,
    isActive: true,
  });

  return traceObject("context", {
    subscriptions: [] as Array<{ dispose(): void }>,
    globalState: createMemento(log, "context.globalState", traceObject, traceNestedCall),
    workspaceState: createMemento(log, "context.workspaceState", traceObject, traceNestedCall),
    secrets: traceObject("context.secrets", {
      get: traceNestedCall("context.secrets.get", (key: string) => {
        log("info", "secrets", `get(${key})`);
        return Promise.resolve(undefined);
      }),
      store: traceNestedCall("context.secrets.store", (key: string, _value: string) => {
        log("info", "secrets", `store(${key})`);
        return Promise.resolve();
      }),
      delete: traceNestedCall("context.secrets.delete", (key: string) => {
        log("info", "secrets", `delete(${key})`);
        return Promise.resolve();
      }),
      onDidChange: traceNestedCall("context.secrets.onDidChange", () => {
        log("info", "secrets", "onDidChange(subscribed)");
        return traceObject("context.secrets.onDidChange.subscription", { dispose() {} });
      }),
    }),
    extensionPath: extensionRoot,
    extensionUri,
    extensionDescriptorUri,
    extensionRootUri,
    extensionPackageJsonUri,
    extensionEntryUri,
    extensionMainUri,
    storageUri: makeFileUri("context.storageUri", ".shim-storage"),
    globalStorageUri: makeFileUri("context.globalStorageUri", ".shim-global-storage"),
    logUri: traceObject("context.logUri", {
      uri: makeFileUri("context.logUri.uri", ".shim-logs"),
      error: traceNestedCall("context.logUri.error", (value?: unknown) => {
        log("error", "context.logUri", safeRender(value));
      }),
      warn: traceNestedCall("context.logUri.warn", (value?: unknown) => {
        log("warn", "context.logUri", safeRender(value));
      }),
      info: traceNestedCall("context.logUri.info", (value?: unknown) => {
        log("info", "context.logUri", safeRender(value));
      }),
      debug: traceNestedCall("context.logUri.debug", (value?: unknown) => {
        log("info", "context.logUri", safeRender(value));
      }),
      trace: traceNestedCall("context.logUri.trace", (value?: unknown) => {
        log("info", "context.logUri", safeRender(value));
      }),
      append: traceNestedCall("context.logUri.append", (value?: unknown) => {
        log("info", "context.logUri", safeRender(value));
      }),
      appendLine: traceNestedCall("context.logUri.appendLine", (value?: unknown) => {
        log("info", "context.logUri", safeRender(value));
      }),
      show: traceNestedCall("context.logUri.show", () => {
        log("info", "context.logUri", "show()");
      }),
      hide: traceNestedCall("context.logUri.hide", () => {
        log("info", "context.logUri", "hide()");
      }),
      clear: traceNestedCall("context.logUri.clear", () => {
        log("info", "context.logUri", "clear()");
      }),
      dispose: traceNestedCall("context.logUri.dispose", () => {
        log("info", "context.logUri", "dispose()");
      }),
      fsPath: `${extensionRoot}\\.shim-logs`,
      path: `/${extensionPathNormalized}/.shim-logs`,
      scheme: "file",
      authority: "",
      query: "",
      fragment: "",
      toString: traceNestedCall("context.logUri.toString", () => {
        return `file:///${extensionPathNormalized}/.shim-logs`;
      }),
      toJSON: traceNestedCall("context.logUri.toJSON", () => {
        return {
          $mid: 1,
          scheme: "file",
          authority: "",
          path: `/${extensionPathNormalized}/.shim-logs`,
          query: "",
          fragment: "",
          fsPath: `${extensionRoot}\\.shim-logs`,
        };
      }),
      with: traceNestedCall("context.logUri.with", (change: Partial<{ scheme: string; authority: string; path: string; query: string; fragment: string; fsPath: string }>) => {
        const nextPath = change.path ?? `/${extensionPathNormalized}/.shim-logs`;
        const nextFsPath = change.fsPath ?? `${extensionRoot}\\.shim-logs`;
        return buildShimUri("context.logUri.with(...)", nextFsPath, traceObject, traceNestedCall);
      }),
    }),
    logPath: `${extensionPathNormalized}/.shim-logs`,
    environmentVariableCollection: createLoggingProxy("context.environmentVariableCollection", log, (kind, path, detail) => {
      traceNestedCall(path, () => undefined);
      return undefined;
    }),
    logger: traceObject("context.logger", {
      error: traceNestedCall("context.logger.error", (value?: unknown) => {
        log("error", "context.logger", safeRender(value));
      }),
      warn: traceNestedCall("context.logger.warn", (value?: unknown) => {
        log("warn", "context.logger", safeRender(value));
      }),
      info: traceNestedCall("context.logger.info", (value?: unknown) => {
        log("info", "context.logger", safeRender(value));
      }),
      debug: traceNestedCall("context.logger.debug", (value?: unknown) => {
        log("info", "context.logger", safeRender(value));
      }),
      trace: traceNestedCall("context.logger.trace", (value?: unknown) => {
        log("info", "context.logger", safeRender(value));
      }),
      log: traceNestedCall("context.logger.log", (value?: unknown) => {
        log("info", "context.logger", safeRender(value));
      }),
    }),
    error: traceNestedCall("context.error", (value?: unknown) => {
      log("error", "context", safeRender(value));
    }),
    warn: traceNestedCall("context.warn", (value?: unknown) => {
      log("warn", "context", safeRender(value));
    }),
    info: traceNestedCall("context.info", (value?: unknown) => {
      log("info", "context", safeRender(value));
    }),
    debug: traceNestedCall("context.debug", (value?: unknown) => {
      log("info", "context", safeRender(value));
    }),
    trace: traceNestedCall("context.trace", (value?: unknown) => {
      log("info", "context", safeRender(value));
    }),
    extensionMode: 1,
    extension,
    extensionRuntimePath: extensionRoot,
    extensionRuntimeUri: makeUri("context.extensionRuntimeUri", extensionRoot),
    extensionDescriptor,
    extensionPathInfo: traceObject("context.extensionPathInfo", {
      value: extensionRoot,
      fsPath: extensionRoot,
      normalized: extensionPathNormalized,
    }),
    extensionDescriptorPath: packageJsonPath,
    extensionPackageJson,
    extensionExports,
    extensionInfo: traceObject("context.extensionInfo", {
      extensionPath: extensionRoot,
      extensionUri: makeUri("context.extensionInfo.extensionUri", extensionRoot),
    }),
    extensionMetadata,
    extensionRootPath: extensionRoot,
    extensionPackage: traceObject("context.extensionPackage", {
      path: packageJsonPath,
      uri: makeUri("context.extensionPackage.uri", packageJsonPath),
    }),
    extensionState: traceObject("context.extensionState", {
      active: true,
      path: extensionRoot,
    }),
    extensionActivationContext: traceObject("context.extensionActivationContext", {
      extensionPath: extensionRoot,
      extensionUri: makeUri("context.extensionActivationContext.extensionUri", extensionRoot),
    }),
    extensionResolvedPath: extensionPathNormalized,
    extensionResolvedUri: makeUri("context.extensionResolvedUri", extensionRoot),
    extensionLocation: traceObject("context.extensionLocation", {
      path: extensionRoot,
      uri: makeUri("context.extensionLocation.uri", extensionRoot),
    }),
    extensionDescriptorInfo: traceObject("context.extensionDescriptorInfo", {
      id: extensionMetadata.id,
      path: packageJsonPath,
    }),
    logResource: traceObject("context.logResource", {
      scheme: "file",
      fsPath: `${extensionRoot}\\.shim-logs`,
      path: `${extensionRoot.replace(/\\/g, "/")}/.shim-logs`,
      toString: traceNestedCall("context.logResource.toString", () => {
        return `file:///${extensionRoot.replace(/\\/g, "/")}/.shim-logs`;
      }),
    }),
    outputChannel: traceObject("context.outputChannel", {
      error: traceNestedCall("context.outputChannel.error", (value?: unknown) => {
        log("error", "context.outputChannel", safeRender(value));
      }),
      warn: traceNestedCall("context.outputChannel.warn", (value?: unknown) => {
        log("warn", "context.outputChannel", safeRender(value));
      }),
      info: traceNestedCall("context.outputChannel.info", (value?: unknown) => {
        log("info", "context.outputChannel", safeRender(value));
      }),
      appendLine: traceNestedCall("context.outputChannel.appendLine", (value?: unknown) => {
        log("info", "context.outputChannel", safeRender(value));
      }),
    }),
    logOutputChannel: traceObject("context.logOutputChannel", {
      error: traceNestedCall("context.logOutputChannel.error", (value?: unknown) => {
        log("error", "context.logOutputChannel", safeRender(value));
      }),
      warn: traceNestedCall("context.logOutputChannel.warn", (value?: unknown) => {
        log("warn", "context.logOutputChannel", safeRender(value));
      }),
      info: traceNestedCall("context.logOutputChannel.info", (value?: unknown) => {
        log("info", "context.logOutputChannel", safeRender(value));
      }),
      debug: traceNestedCall("context.logOutputChannel.debug", (value?: unknown) => {
        log("info", "context.logOutputChannel", safeRender(value));
      }),
      trace: traceNestedCall("context.logOutputChannel.trace", (value?: unknown) => {
        log("info", "context.logOutputChannel", safeRender(value));
      }),
      appendLine: traceNestedCall("context.logOutputChannel.appendLine", (value?: unknown) => {
        log("info", "context.logOutputChannel", safeRender(value));
      }),
      show: traceNestedCall("context.logOutputChannel.show", () => undefined),
      dispose: traceNestedCall("context.logOutputChannel.dispose", () => undefined),
    }),
    subscriptionsLog: traceObject("context.subscriptionsLog", {
      error: traceNestedCall("context.subscriptionsLog.error", (value?: unknown) => {
        log("error", "context.subscriptionsLog", safeRender(value));
      }),
    }),
    extensionModeName: "production",
    extensionRuntime: "node",
    extensionHostKind: 1,
    extensionKind: 1,
    languageModelAccessInformation: traceObject("context.languageModelAccessInformation", {
      onDidChange: traceNestedCall("context.languageModelAccessInformation.onDidChange", () => {
        return traceObject("context.languageModelAccessInformation.subscription", { dispose() {} });
      }),
    }),
    workspaceValue: traceObject("context.workspaceValue", {
      error: traceNestedCall("context.workspaceValue.error", (value?: unknown) => {
        log("error", "context.workspaceValue", safeRender(value));
      }),
    }),
    logFile: `${extensionRoot.replace(/\\/g, "/")}/.shim-logs/log.txt`,
    logLocation: `${extensionRoot.replace(/\\/g, "/")}/.shim-logs`,
    telemetryLogger: traceObject("context.telemetryLogger", {
      error: traceNestedCall("context.telemetryLogger.error", (value?: unknown) => {
        log("error", "context.telemetryLogger", safeRender(value));
      }),
      logError: traceNestedCall("context.telemetryLogger.logError", (value?: unknown) => {
        log("error", "context.telemetryLogger", safeRender(value));
      }),
    }),
    extensionContext: undefined,
    extensionName: "claude-code-shim",
    storagePath: `${extensionRoot.replace(/\\/g, "/")}/.shim-storage`,
    globalStoragePath: `${extensionRoot.replace(/\\/g, "/")}/.shim-global-storage`,
    logName: "shim",
    logLevel: 3,
    logService: traceObject("context.logService", {
      error: traceNestedCall("context.logService.error", (value?: unknown) => {
        log("error", "context.logService", safeRender(value));
      }),
      warn: traceNestedCall("context.logService.warn", (value?: unknown) => {
        log("warn", "context.logService", safeRender(value));
      }),
      info: traceNestedCall("context.logService.info", (value?: unknown) => {
        log("info", "context.logService", safeRender(value));
      }),
    }),
    output: traceObject("context.output", {
      error: traceNestedCall("context.output.error", (value?: unknown) => {
        log("error", "context.output", safeRender(value));
      }),
    }),
    loggerService: traceObject("context.loggerService", {
      error: traceNestedCall("context.loggerService.error", (value?: unknown) => {
        log("error", "context.loggerService", safeRender(value));
      }),
    }),
    extensionLogger: traceObject("context.extensionLogger", {
      error: traceNestedCall("context.extensionLogger.error", (value?: unknown) => {
        log("error", "context.extensionLogger", safeRender(value));
      }),
    }),
    activationLogger: traceObject("context.activationLogger", {
      error: traceNestedCall("context.activationLogger.error", (value?: unknown) => {
        log("error", "context.activationLogger", safeRender(value));
      }),
    }),
    logging: traceObject("context.logging", {
      error: traceNestedCall("context.logging.error", (value?: unknown) => {
        log("error", "context.logging", safeRender(value));
      }),
    }),
    environmentVariables: traceObject("context.environmentVariables", {
      error: traceNestedCall("context.environmentVariables.error", (value?: unknown) => {
        log("error", "context.environmentVariables", safeRender(value));
      }),
    }),
    loggerFactory: traceObject("context.loggerFactory", {
      error: traceNestedCall("context.loggerFactory.error", (value?: unknown) => {
        log("error", "context.loggerFactory", safeRender(value));
      }),
    }),
    contextValue: traceObject("context.contextValue", {
      error: traceNestedCall("context.contextValue.error", (value?: unknown) => {
        log("error", "context.contextValue", safeRender(value));
      }),
    }),
    contextLogger: traceObject("context.contextLogger", {
      error: traceNestedCall("context.contextLogger.error", (value?: unknown) => {
        log("error", "context.contextLogger", safeRender(value));
      }),
    }),
    extensionEnvironment: traceObject("context.extensionEnvironment", {
      error: traceNestedCall("context.extensionEnvironment.error", (value?: unknown) => {
        log("error", "context.extensionEnvironment", safeRender(value));
      }),
    }),
    environmentLogger: traceObject("context.environmentLogger", {
      error: traceNestedCall("context.environmentLogger.error", (value?: unknown) => {
        log("error", "context.environmentLogger", safeRender(value));
      }),
    }),
    activationOutput: traceObject("context.activationOutput", {
      error: traceNestedCall("context.activationOutput.error", (value?: unknown) => {
        log("error", "context.activationOutput", safeRender(value));
      }),
    }),
    activationState: traceObject("context.activationState", {
      error: traceNestedCall("context.activationState.error", (value?: unknown) => {
        log("error", "context.activationState", safeRender(value));
      }),
    }),
    extensionStorageUri: traceObject("context.extensionStorageUri", {
      scheme: "file",
      fsPath: `${extensionRoot}\\.shim-extension-storage`,
      path: `${extensionRoot.replace(/\\/g, "/")}/.shim-extension-storage`,
      toString: traceNestedCall("context.extensionStorageUri.toString", () => {
        return `file:///${extensionRoot.replace(/\\/g, "/")}/.shim-extension-storage`;
      }),
    }),
    extensionLogUri: traceObject("context.extensionLogUri", {
      scheme: "file",
      fsPath: `${extensionRoot}\\.shim-extension-logs`,
      path: `${extensionRoot.replace(/\\/g, "/")}/.shim-extension-logs`,
      toString: traceNestedCall("context.extensionLogUri.toString", () => {
        return `file:///${extensionRoot.replace(/\\/g, "/")}/.shim-extension-logs`;
      }),
    }),
    extensionLogPath: `${extensionRoot.replace(/\\/g, "/")}/.shim-extension-logs`,
    storagePathUri: traceObject("context.storagePathUri", {
      scheme: "file",
      fsPath: `${extensionRoot}\\.shim-storage`,
      path: `${extensionRoot.replace(/\\/g, "/")}/.shim-storage`,
      toString: traceNestedCall("context.storagePathUri.toString", () => {
        return `file:///${extensionRoot.replace(/\\/g, "/")}/.shim-storage`;
      }),
    }),
    globalStoragePathUri: traceObject("context.globalStoragePathUri", {
      scheme: "file",
      fsPath: `${extensionRoot}\\.shim-global-storage`,
      path: `${extensionRoot.replace(/\\/g, "/")}/.shim-global-storage`,
      toString: traceNestedCall("context.globalStoragePathUri.toString", () => {
        return `file:///${extensionRoot.replace(/\\/g, "/")}/.shim-global-storage`;
      }),
    }),
    logPathUri: traceObject("context.logPathUri", {
      scheme: "file",
      fsPath: `${extensionRoot}\\.shim-logs`,
      path: `${extensionRoot.replace(/\\/g, "/")}/.shim-logs`,
      toString: traceNestedCall("context.logPathUri.toString", () => {
        return `file:///${extensionRoot.replace(/\\/g, "/")}/.shim-logs`;
      }),
    }),
    extensionLoggerFactory: traceObject("context.extensionLoggerFactory", {
      error: traceNestedCall("context.extensionLoggerFactory.error", (value?: unknown) => {
        log("error", "context.extensionLoggerFactory", safeRender(value));
      }),
    }),
    shimLogChannel: traceObject("context.shimLogChannel", {
      error: traceNestedCall("context.shimLogChannel.error", (value?: unknown) => {
        log("error", "context.shimLogChannel", safeRender(value));
      }),
    }),
    shimLogger: traceObject("context.shimLogger", {
      error: traceNestedCall("context.shimLogger.error", (value?: unknown) => {
        log("error", "context.shimLogger", safeRender(value));
      }),
    }),
    contextErrorLogger: traceObject("context.contextErrorLogger", {
      error: traceNestedCall("context.contextErrorLogger.error", (value?: unknown) => {
        log("error", "context.contextErrorLogger", safeRender(value));
      }),
    }),
    outputLogger: traceObject("context.outputLogger", {
      error: traceNestedCall("context.outputLogger.error", (value?: unknown) => {
        log("error", "context.outputLogger", safeRender(value));
      }),
    }),
    activationLogChannel: traceObject("context.activationLogChannel", {
      error: traceNestedCall("context.activationLogChannel.error", (value?: unknown) => {
        log("error", "context.activationLogChannel", safeRender(value));
      }),
    }),
    extensionLogChannel: traceObject("context.extensionLogChannel", {
      error: traceNestedCall("context.extensionLogChannel.error", (value?: unknown) => {
        log("error", "context.extensionLogChannel", safeRender(value));
      }),
    }),
    extensionEnvironmentLogger: traceObject("context.extensionEnvironmentLogger", {
      error: traceNestedCall("context.extensionEnvironmentLogger.error", (value?: unknown) => {
        log("error", "context.extensionEnvironmentLogger", safeRender(value));
      }),
    }),
    activationEnvironmentLogger: traceObject("context.activationEnvironmentLogger", {
      error: traceNestedCall("context.activationEnvironmentLogger.error", (value?: unknown) => {
        log("error", "context.activationEnvironmentLogger", safeRender(value));
      }),
    }),
    contextLogUri: traceObject("context.contextLogUri", {
      scheme: "file",
      fsPath: `${extensionRoot}\\.shim-logs`,
      path: `${extensionRoot.replace(/\\/g, "/")}/.shim-logs`,
      toString: traceNestedCall("context.contextLogUri.toString", () => {
        return `file:///${extensionRoot.replace(/\\/g, "/")}/.shim-logs`;
      }),
    }),
    contextStorageUri: traceObject("context.contextStorageUri", {
      scheme: "file",
      fsPath: `${extensionRoot}\\.shim-storage`,
      path: `${extensionRoot.replace(/\\/g, "/")}/.shim-storage`,
      toString: traceNestedCall("context.contextStorageUri.toString", () => {
        return `file:///${extensionRoot.replace(/\\/g, "/")}/.shim-storage`;
      }),
    }),
    contextGlobalStorageUri: traceObject("context.contextGlobalStorageUri", {
      scheme: "file",
      fsPath: `${extensionRoot}\\.shim-global-storage`,
      path: `${extensionRoot.replace(/\\/g, "/")}/.shim-global-storage`,
      toString: traceNestedCall("context.contextGlobalStorageUri.toString", () => {
        return `file:///${extensionRoot.replace(/\\/g, "/")}/.shim-global-storage`;
      }),
    }),
    logResourceUri: traceObject("context.logResourceUri", {
      scheme: "file",
      fsPath: `${extensionRoot}\\.shim-logs`,
      path: `${extensionRoot.replace(/\\/g, "/")}/.shim-logs`,
      toString: traceNestedCall("context.logResourceUri.toString", () => {
        return `file:///${extensionRoot.replace(/\\/g, "/")}/.shim-logs`;
      }),
    }),
    telemetryLog: traceObject("context.telemetryLog", {
      error: traceNestedCall("context.telemetryLog.error", (value?: unknown) => {
        log("error", "context.telemetryLog", safeRender(value));
      }),
    }),
    loggingService: traceObject("context.loggingService", {
      error: traceNestedCall("context.loggingService.error", (value?: unknown) => {
        log("error", "context.loggingService", safeRender(value));
      }),
    }),
    shimContextError: traceNestedCall("context.shimContextError", (value?: unknown) => {
      log("error", "context", safeRender(value));
    }),
    asAbsolutePath: traceNestedCall("context.asAbsolutePath", (relativePath: string) => {
      return `${extensionRoot.replace(/\\/g, "/")}/${relativePath}`;
    }),
  });
}

export function createFallbackVsCodeProxy(
  log: (level: ShimLogEntry["level"], scope: string, message: string) => void,
  trace?: (kind: ShimAccessEvent["kind"], path: string, detail?: string) => void,
) {
  return createLoggingProxy("vscode-proxy", log, trace);
}

export { safeRender };

// Deep-copy a webview message into plain, JSON-safe data. The extension builds these
// payloads inside the vm sandbox, so a structured round-trip strips any cross-realm
// prototypes; if the value is not JSON-serializable we keep the rendered string instead.
function cloneMessagePayload(message: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(message));
  } catch {
    return safeRender(message);
  }
}

function safeRender(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// Errors thrown by the extension run in a vm sandbox realm, so `instanceof Error` is false.
// Duck-type `stack`/`message` so we keep the useful text regardless of realm.
function describeFacadeError(error: unknown): string {
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
