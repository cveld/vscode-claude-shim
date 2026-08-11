import Head from "next/head";
import { useEffect, useState } from "react";
import SimulatorTargetCard from "@/components/SimulatorTargetCard";
import SimulatorInstancePanel from "@/components/SimulatorInstancePanel";
import DiagnosticsPanel from "@/components/DiagnosticsPanel";
import WebviewExperimentPanel from "@/components/WebviewExperimentPanel";
import ClaudeWebviewSidebar from "@/components/ClaudeWebviewSidebar";
import ShimSummaryPanel from "@/components/ShimSummaryPanel";
import { pinnedLabel } from "@/simulator-lib/config";

declare global {
  interface Window {
    __simSessionResetDone?: boolean;
  }
}

export default function Home() {
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [sessionReady, setSessionReady] = useState(false);

  function changed() {
    setRefreshSignal((n) => n + 1);
  }

  // Give each page load a clean shim session: one browser webview ⇄ one freshly-resolved view,
  // matching the real VS Code lifecycle. Reusing a session across reloads leaves the bundle
  // stuck "loading" (it re-boots against an already-initialized view). Reset first, then render
  // the sidebar/observer so they all attach to the same fresh session.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.__simSessionResetDone) {
      setSessionReady(true);
      return;
    }
    window.__simSessionResetDone = true;
    fetch("/api/shim-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reset: true }),
    })
      .catch(() => {})
      .finally(() => setSessionReady(true));
  }, []);

  return (
    <>
      <Head>
        <title>{pinnedLabel()} — VS Code simulator</title>
      </Head>
      <div className="app-shell">
        <main className="app-main">
          <div>
            <h1>{pinnedLabel()}</h1>
            <p className="subtitle">
              Local mock IDE host for testing the documented Claude lock-file and WebSocket discovery flow against this workspace.
            </p>
          </div>

          <SimulatorTargetCard onChanged={changed} />
          <ShimSummaryPanel />
          <WebviewExperimentPanel sessionReady={sessionReady} />
          <SimulatorInstancePanel refreshSignal={refreshSignal} onChanged={changed} />
          <DiagnosticsPanel />
        </main>

        {sessionReady ? (
          <ClaudeWebviewSidebar />
        ) : (
          <aside className="app-webview-sidebar" data-testid="webview-render-surface">
            <div className="render-surface-toolbar">Real Claude webview</div>
            <div className="muted" style={{ padding: "1rem" }}>Preparing a fresh session…</div>
          </aside>
        )}
      </div>
    </>
  );
}
