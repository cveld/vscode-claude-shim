import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, getWebviewTarget, type WebviewTargetInfo } from "@/simulator-lib/api";

type LogEntry = {
  id: number;
  kind: "info" | "error" | "message";
  text: string;
};

const VIEW_ID = "claudeVSCodeSidebar";

export default function WebviewExperimentPanel({ sessionReady = true }: { sessionReady?: boolean }) {
  const [target, setTarget] = useState<WebviewTargetInfo | null>(null);
  const [status, setStatus] = useState("Resolving configured webview bundle…");
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const nextId = useRef(1);

  function appendLog(entry: Omit<LogEntry, "id">) {
    setLogs((prev) => [...prev.slice(-79), { id: nextId.current++, ...entry }]);
  }

  useEffect(() => {
    getWebviewTarget()
      .then((result) => {
        setTarget(result);
        setStatus("Bundle metadata loaded; booting webview in isolated iframe…");
      })
      .catch((err) => {
        setError(describeError(err));
        setStatus("Bundle metadata failed.");
      });
  }, []);

  // Observe the host→webview stream in the parent purely for the event log. The iframe runs its
  // own bridge/stream for the actual bundle; the shim session supports multiple subscribers.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!sessionReady) return;
    const sse = new EventSource(`/api/webview-stream?viewId=${encodeURIComponent(VIEW_ID)}`);
    sse.addEventListener("connected", () => appendLog({ kind: "info", text: "Host→webview stream connected (observer)." }));
    sse.onmessage = (ev) => {
      try {
        const payload = JSON.parse(ev.data) as { message: unknown };
        appendLog({ kind: "message", text: safeRender(payload.message) });
      } catch (err) {
        appendLog({ kind: "error", text: `bad SSE payload: ${describeError(err)}` });
      }
    };
    sse.onerror = () => appendLog({ kind: "error", text: "Host→webview stream error (observer)." });
    return () => sse.close();
  }, [sessionReady]);

  const recentLogs = useMemo(() => logs.slice().reverse(), [logs]);

  return (
    <section className="panel" data-testid="webview-experiment-panel">
      <h2>Render-first webview experiment</h2>
      <p className="subtitle">
        The shipped Claude extension webview runs in an isolated same-origin iframe in the sidebar, driven by the real extension code in the live shim session. This panel mirrors its host→webview traffic.
      </p>

      <table>
        <tbody>
          <tr>
            <th>Extension</th>
            <td>{target ? <code>{target.extensionLabel}</code> : "—"}</td>
          </tr>
          <tr>
            <th>Asset root</th>
            <td>{target ? <code>{target.assetRoot}</code> : "—"}</td>
          </tr>
          <tr>
            <th>Entry script</th>
            <td>{target ? <code>{target.entryScriptUrl}</code> : "—"}</td>
          </tr>
          <tr>
            <th>Status</th>
            <td data-testid="webview-experiment-status">{status}</td>
          </tr>
        </tbody>
      </table>
      {error ? <p className="error-text">{error}</p> : null}

      <div className="event-log" data-testid="webview-event-log">
        <div className="event-log-header">
          <strong>Event log</strong>
          <span className="muted">host→webview, newest first, latest 80.</span>
        </div>
        {recentLogs.length === 0 ? (
          <p className="muted">No events captured yet.</p>
        ) : (
          <ul className="event-log-list">
            {recentLogs.map((entry) => (
              <li key={entry.id} className={`event-log-item ${entry.kind}`}>
                <span className="event-log-kind">{entry.kind}</span>
                <code>{entry.text}</code>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function safeRender(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unknown error";
}
