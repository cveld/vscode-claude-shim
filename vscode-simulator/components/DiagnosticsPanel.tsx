import { useEffect, useState } from "react";
import { ApiError, getDiagnostics, type Diagnostics } from "@/simulator-lib/api";

export default function DiagnosticsPanel() {
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDiagnostics()
      .then(setDiagnostics)
      .catch((err) => setError(describeError(err)));
  }, []);

  return (
    <section className="panel">
      <h2>Mock host diagnostics</h2>
      <p className="subtitle">
        This version focuses on the documented lock-file and WebSocket discovery flow, not full VS Code API emulation.
      </p>
      {error ? <p className="error-text">{error}</p> : null}
      {!diagnostics && !error ? <p className="muted">Loading diagnostics…</p> : null}
      {diagnostics ? (
        <>
          <table style={{ marginTop: "1rem" }}>
            <tbody>
              <tr>
                <th>Lock-file directory</th>
                <td><code>{diagnostics.lockFileDir}</code></td>
              </tr>
              <tr>
                <th>Transport</th>
                <td><code>{diagnostics.transport}</code></td>
              </tr>
              <tr>
                <th>Authorization header</th>
                <td><code>{diagnostics.authorizationHeader}</code></td>
              </tr>
              <tr>
                <th>Runtime state</th>
                <td>{diagnostics.runtimeState}</td>
              </tr>
              <tr>
                <th>Protocol port</th>
                <td>{diagnostics.port ? <code>{diagnostics.port}</code> : "—"}</td>
              </tr>
              <tr>
                <th>PID</th>
                <td>{diagnostics.pid ? <code>{diagnostics.pid}</code> : "—"}</td>
              </tr>
              <tr>
                <th>Lock file</th>
                <td>{diagnostics.lockFilePath ? <code>{diagnostics.lockFilePath}</code> : "—"}</td>
              </tr>
              <tr>
                <th>Allowed root</th>
                <td>{diagnostics.pinnedTargetInAllowedRoot ? "Yes" : "No"}</td>
              </tr>
              <tr>
                <th>Pinned target exists</th>
                <td>{diagnostics.pinnedTargetExists ? "Yes" : "No"}</td>
              </tr>
              <tr>
                <th>Host ~/.claude writable</th>
                <td>{diagnostics.claudeDirWritable ? "Yes" : "No"}</td>
              </tr>
              <tr>
                <th>Last connection</th>
                <td>{diagnostics.lastConnectionAt ?? "—"}</td>
              </tr>
              <tr>
                <th>Last error</th>
                <td>{diagnostics.lastError ?? "—"}</td>
              </tr>
              <tr>
                <th>Lock-file fields</th>
                <td>{diagnostics.lockFileFields.map((field) => <code key={field} style={{ marginRight: "0.4rem" }}>{field}</code>)}</td>
              </tr>
              <tr>
                <th>Workspace folders</th>
                <td>{diagnostics.workspaceFolders.map((folder) => <code key={folder} style={{ marginRight: "0.4rem" }}>{folder}</code>)}</td>
              </tr>
            </tbody>
          </table>

          <ul className="notes-list">
            {diagnostics.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
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
