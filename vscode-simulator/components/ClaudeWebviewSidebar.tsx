const VIEW_ID = "claudeVSCodeSidebar";
const DOCUMENT_URL = `/api/webview-document?viewId=${encodeURIComponent(VIEW_ID)}`;

// The real Claude webview as a full-height sidebar of the whole simulator. It runs in an
// isolated same-origin iframe so it gets its own viewport: the composer stays pinned at the
// bottom and floating popovers position correctly. The iframe carries its own bridge (see
// /api/webview-document) that relays messages to/from the live shim session.
export default function ClaudeWebviewSidebar() {
  return (
    <aside className="app-webview-sidebar" data-testid="webview-render-surface">
      <div className="render-surface-toolbar">Real Claude webview</div>
      <iframe
        data-testid="webview-frame"
        className="webview-frame"
        src={DOCUMENT_URL}
        title="Claude webview sidebar"
      />
    </aside>
  );
}
