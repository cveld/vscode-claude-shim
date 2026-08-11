import { useEffect, useState } from "react";
import { ApiError, getShimSummary, type ShimSummary } from "@/simulator-lib/api";

export default function ShimSummaryPanel() {
  const [summary, setSummary] = useState<ShimSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getShimSummary()
      .then(setSummary)
      .catch((err) => setError(describeError(err)));
  }, []);

  return (
    <section className="panel">
      <h2>Extension host shim probe</h2>
      <p className="subtitle">
        This probe tries to load the real Claude extension with a deliberately tiny VS Code API facade and reports what the extension registers before it hits unsupported host surface.
      </p>

      {error ? <p className="error-text">{error}</p> : null}
      {!summary && !error ? <p className="muted">Loading shim probe…</p> : null}

      {summary ? (
        <>
          <table style={{ marginTop: "1rem" }}>
            <tbody>
              <tr>
                <th>Extension</th>
                <td><code>{summary.extensionPath}</code></td>
              </tr>
              <tr>
                <th>Version</th>
                <td><code>{summary.extensionVersion}</code></td>
              </tr>
              <tr>
                <th>Activation attempted</th>
                <td>{summary.activationAttempted ? "Yes" : "No"}</td>
              </tr>
              <tr>
                <th>Activation completed</th>
                <td>{summary.activationCompleted ? "Yes" : "No"}</td>
              </tr>
              <tr>
                <th>Failure kind</th>
                <td>{summary.activationFailureKind ? <code>{summary.activationFailureKind}</code> : "—"}</td>
              </tr>
              <tr>
                <th>Failure summary</th>
                <td>{summary.activationFailureSummary ? <code>{summary.activationFailureSummary}</code> : "—"}</td>
              </tr>
              <tr>
                <th>Activation error</th>
                <td>{summary.activationError ? <code>{summary.activationError}</code> : "—"}</td>
              </tr>
              <tr>
                <th>{summary.diagnostics.evidenceType === "heuristic" ? "Likely undefined base" : "Likely failing path"}</th>
                <td>{summary.diagnostics.likelyFailingPath ? <code>{summary.diagnostics.likelyFailingPath}</code> : "—"}</td>
              </tr>
              <tr>
                <th>Suspected property</th>
                <td>{summary.diagnostics.suspectedProperty ? <code>.{summary.diagnostics.suspectedProperty}</code> : "—"}</td>
              </tr>
              <tr>
                <th>Evidence type</th>
                <td>{summary.diagnostics.evidenceType ? <code>{summary.diagnostics.evidenceType}</code> : "—"}</td>
              </tr>
              <tr>
                <th>Failure confidence</th>
                <td>{summary.diagnostics.likelyFailingConfidence ? <code>{summary.diagnostics.likelyFailingConfidence}</code> : "—"}</td>
              </tr>
              <tr>
                <th>Failure reason</th>
                <td>{summary.diagnostics.likelyFailingReason ? <code>{summary.diagnostics.likelyFailingReason}</code> : "—"}</td>
              </tr>
              <tr>
                <th>Trace capture</th>
                <td>
                  <code>{summary.diagnostics.recentAccesses.length}</code> recent access events
                  {summary.diagnostics.truncated ? <span className="muted"> (showing tail of {summary.diagnostics.totalRecorded})</span> : null}
                </td>
              </tr>
              <tr>
                <th>Failure frames</th>
                <td>
                  {summary.diagnostics.failureFrames.length === 0 ? "—" : summary.diagnostics.failureFrames.map((frame, index) => (
                    <div key={`${frame.raw}:${index}`}><code>{frame.raw}</code> <span className="muted">({frame.classification})</span></div>
                  ))}
                </td>
              </tr>
            </tbody>
          </table>

          <div className="event-log" style={{ marginTop: "1rem" }}>
            <div className="event-log-header">
              <strong>Failure correlation</strong>
              <span className="muted">Best candidate chain for the current activation error.</span>
            </div>
            {summary.diagnostics.correlatedAccesses.length === 0 ? <p className="muted">No correlated shim access diagnostics captured.</p> : (
              <ul className="event-log-list">
                {summary.diagnostics.correlatedAccesses.map((entry) => (
                  <li key={`${entry.seq}:${entry.path}:${entry.kind}:correlated`} className={`event-log-item ${entry.kind === "throw" || entry.kind === "return-undefined" || entry.kind === "unsupported" ? "error" : "message"}`}>
                    <span className="event-log-kind">{entry.kind}</span>
                    <code>{entry.path}{entry.detail ? ` — ${entry.detail}` : ""}</code>
                    {entry.source ? <span className="muted"> source={entry.source}</span> : null}
                    {entry.derived ? <span className="muted"> derived</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="event-log" style={{ marginTop: "1rem" }}>
            <div className="event-log-header">
              <strong>Recent shim accesses</strong>
              <span className="muted">Newest first, capped to the latest {summary.diagnostics.recentAccesses.length || 0} entries.</span>
            </div>
            {summary.diagnostics.recentAccesses.length === 0 ? <p className="muted">No shim access diagnostics captured.</p> : (
              <ul className="event-log-list">
                {summary.diagnostics.recentAccesses.slice().reverse().map((entry) => (
                  <li key={`${entry.seq}:${entry.path}:${entry.kind}`} className={`event-log-item ${entry.kind === "throw" || entry.kind === "return-undefined" || entry.kind === "unsupported" ? "error" : "message"}`}>
                    <span className="event-log-kind">{entry.kind}</span>
                    <code>{entry.path}{entry.detail ? ` — ${entry.detail}` : ""}</code>
                    {entry.source ? <span className="muted"> source={entry.source}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <table style={{ marginTop: "1rem" }}>
            <tbody>
              <tr>
                <th>Workspace folders</th>
                <td>{summary.workspaceFolders.map((folder) => <code key={folder} style={{ marginRight: "0.4rem" }}>{folder}</code>)}</td>
              </tr>
            </tbody>
          </table>


          <div className="experiment-grid" style={{ marginTop: "1rem" }}>
            <div>
              <h3>Manifest contributions</h3>
              <p><strong>Activation events</strong></p>
              <ul className="notes-list">
                {summary.activationEvents.map((item) => <li key={item}><code>{item}</code></li>)}
              </ul>
              <p><strong>Config keys</strong></p>
              <ul className="notes-list">
                {summary.configKeys.slice(0, 12).map((item) => <li key={item}><code>{item}</code></li>)}
              </ul>
              {summary.configKeys.length > 12 ? <p className="muted">+ {summary.configKeys.length - 12} more config keys</p> : null}
              <p><strong>Contributed commands</strong></p>
              <ul className="notes-list">
                {summary.commandContributions.slice(0, 12).map((item) => <li key={item}><code>{item}</code></li>)}
              </ul>
              {summary.commandContributions.length > 12 ? <p className="muted">+ {summary.commandContributions.length - 12} more contributed commands</p> : null}
            </div>

            <div>
              <h3>Observed shim registrations</h3>
              <p><strong>Registered commands</strong></p>
              {summary.commandsRegistered.length === 0 ? <p className="muted">None observed yet.</p> : (
                <ul className="notes-list">
                  {summary.commandsRegistered.map((command) => (
                    <li key={`${command.registeredVia}:${command.id}`}>
                      <code>{command.id}</code> <span className="muted">via {command.registeredVia}</span>
                    </li>
                  ))}
                </ul>
              )}

              <p><strong>Registered views/panels</strong></p>
              {summary.viewsRegistered.length === 0 ? <p className="muted">None observed yet.</p> : (
                <ul className="notes-list">
                  {summary.viewsRegistered.map((view) => (
                    <li key={`${view.type}:${view.id}`}>
                      <code>{view.id}</code> <span className="muted">({view.type}{view.title ? `, ${view.title}` : ""})</span>
                    </li>
                  ))}
                </ul>
              )}

              <p><strong>Unsupported API calls</strong></p>
              {summary.unsupportedApiCalls.length === 0 ? <p className="muted">No unsupported calls recorded.</p> : (
                <ul className="notes-list">
                  {summary.unsupportedApiCalls.map((item) => <li key={item}><code>{item}</code></li>)}
                </ul>
              )}
            </div>
          </div>

          <div className="event-log" style={{ marginTop: "1rem" }}>
            <div className="event-log-header">
              <strong>Resolved webview views</strong>
              <span className="muted">Host-produced HTML captured from resolveWebviewView(...).</span>
            </div>
            {(summary.resolvedViews ?? []).length === 0 ? <p className="muted">No webview views resolved yet.</p> : (
              (summary.resolvedViews ?? []).map((view) => (
                <div key={view.id} style={{ marginBottom: "0.75rem" }}>
                  <p>
                    <code>{view.id}</code>{" "}
                    <span className="muted">
                      resolved={view.resolved ? "yes" : "no"}, html={view.htmlLength} chars, postMessages={view.postMessageCount}
                    </span>
                  </p>
                  {view.error ? <p className="error-text"><code>{view.error}</code></p> : null}
                  {view.html ? (
                    <pre style={{ maxHeight: "16rem", overflow: "auto", whiteSpace: "pre-wrap" }}>
                      <code>{view.html.slice(0, 4000)}{view.html.length > 4000 ? "\n… (truncated)" : ""}</code>
                    </pre>
                  ) : <p className="muted">No HTML captured.</p>}
                </div>
              ))
            )}
          </div>

          <div className="event-log" style={{ marginTop: "1rem" }}>
            <div className="event-log-header">
              <strong>Shim log</strong>
              <span className="muted">Newest first, capped to the latest 80 entries.</span>
            </div>
            {summary.logs.length === 0 ? <p className="muted">No shim logs captured.</p> : (
              <ul className="event-log-list">
                {summary.logs.slice().reverse().slice(0, 80).map((entry, index) => (
                  <li key={`${entry.scope}:${entry.message}:${index}`} className={`event-log-item ${entry.level === "error" ? "error" : entry.level === "warn" ? "info" : "message"}`}>
                    <span className="event-log-kind">{entry.level}</span>
                    <code>[{entry.scope}] {entry.message}</code>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unknown error";
}
