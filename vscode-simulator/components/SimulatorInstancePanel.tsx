import { useEffect, useState } from "react";
import { ApiError, getInstance, stopInstance, type Instance } from "@/simulator-lib/api";

const POLL_MS = 5000;

type Props = {
  refreshSignal: number;
  onChanged: () => void;
};

export default function SimulatorInstancePanel({ refreshSignal, onChanged }: Props) {
  const [instance, setInstance] = useState<Instance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  function refresh() {
    getInstance()
      .then(setInstance)
      .catch((err) => setError(describeError(err)));
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_MS);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (refreshSignal > 0) refresh();
  }, [refreshSignal]);

  async function stop() {
    setStopping(true);
    setError(null);
    try {
      await stopInstance();
      refresh();
      onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setStopping(false);
    }
  }

  return (
    <section className="panel">
      <h2>Simulator runtime</h2>
      {!instance ? (
        <p className="muted">No local simulator instance is running right now.</p>
      ) : (
        <table>
          <tbody>
            <tr>
              <th>Target</th>
              <td>
                {instance.rootId}/{instance.relativePath || "—"}
              </td>
            </tr>
            <tr>
              <th>Workspace</th>
              <td><code>{instance.hostPath}</code></td>
            </tr>
            <tr>
              <th>Transport</th>
              <td><code>{instance.transport}</code></td>
            </tr>
            <tr>
              <th>Endpoint</th>
              <td>{instance.port ? <code>{`ws://127.0.0.1:${instance.port}`}</code> : "—"}</td>
            </tr>
            <tr>
              <th>PID</th>
              <td><code>{instance.pid}</code></td>
            </tr>
            <tr>
              <th>Lock file</th>
              <td>{instance.lockFilePath ? <code>{instance.lockFilePath}</code> : "—"}</td>
            </tr>
            <tr>
              <th>State</th>
              <td>{instance.state}</td>
            </tr>
            <tr>
              <th>Started</th>
              <td>{instance.startedAt ?? "—"}</td>
            </tr>
            <tr>
              <th>Last connection</th>
              <td>{instance.lastConnectionAt ?? "—"}</td>
            </tr>
            <tr>
              <th>Auth token</th>
              <td>{instance.authTokenPresent ? "Present" : "Missing"}</td>
            </tr>
            <tr>
              <th>Workspaces</th>
              <td>{instance.workspaceFolders.map((folder) => <code key={folder} style={{ marginRight: "0.4rem" }}>{folder}</code>)}</td>
            </tr>
            <tr>
              <th />
              <td>
                <button className="stop-btn" disabled={stopping} onClick={stop}>
                  {stopping ? "Stopping…" : "Stop simulator"}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      )}
      {error ? <p className="error-text">{error}</p> : null}
    </section>
  );
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unknown error";
}
