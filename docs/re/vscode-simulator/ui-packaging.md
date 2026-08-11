# RE: Claude extension UI packaging (basis for the mock shell)

Research backing the **vscode-simulator** experiment (`vscode-simulator/`, a Next.js app on
`127.0.0.1:4592`) — a render-first "mock shell" that tries to host the Claude extension's own
webview bundle outside a full VS Code workbench.

Reverse-engineering of the installed extension package
(`anthropic.claude-code-2.1.209-win32-x64`) shows the visible Claude UI is **not** a purely
native workbench/tree-view surface.

Key findings:

- The extension ships a real browser bundle under `webview/`:
  - `webview/index.js`
  - `webview/index.css`
- `package.json` contributes multiple **webview** views:
  - `claudeVSCodeSidebar`
  - `claudeVSCodeSidebarSecondary`
  - `claudeVSCodeSessionsList`
- The extension also activates on `onWebviewPanel:claudeVSCodePanel`.
- `extension.js` registers webview-backed UI via:
  - `registerWebviewViewProvider(...)`
  - `createWebviewPanel(...)`
  - `webview.postMessage(...)`
  - `webview.onDidReceiveMessage(...)`
  - `asWebviewUri(...)`

Practical interpretation:

- The Claude UI is best classified as **hybrid and strongly webview-based**, not purely
  workbench-native.
- A browser mock shell should therefore start with a **render-first** experiment around the
  shipped webview bundle and a minimal `acquireVsCodeApi()` bridge before attempting a broader
  proxy-shell architecture. The simulator's `lib/vscodeApiFacade.ts`, `lib/extensionHostShim.ts`,
  `lib/webviewAssets.ts`, and `lib/webviewInspection.ts` are the current expressions of this.

## Inspecting the webview bundle

`vscode-simulator` has an inspection harness: `npm run inspect:webview` (Playwright,
`tests/webview-inspection.spec.ts`) plus `lib/webviewInspection.ts` / `lib/webviewAssets.ts`.
Use it to observe what the shipped `webview/index.js` expects from its host (messages,
`acquireVsCodeApi` calls, asset URIs) before hand-building the facade.

See also: [ide-protocol.md](../ide-protocol.md) — the extension/CLI detection the simulator must
also satisfy if it ever hosts a live extension rather than just its rendered UI.
