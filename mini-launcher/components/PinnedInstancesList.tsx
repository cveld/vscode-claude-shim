// Shows running launcher instances filtered to the pinned target only.

import { useEffect, useState } from "react";
import { ApiError, getInstance, stopInstance, type Instance } from "@/mini-lib/api";

const POLL_MS = 5000;

type Props = {
  refreshSignal: number;
  onChanged: () => void;
};

export default function PinnedInstancesList({ refreshSignal, onChanged }: Props) {
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

  if (!instance) return null;

  return (
    <section className="panel">
      <h2>Running instance</h2>
      <table>
        <thead>
          <tr>
            <th>Project</th>
            <th>URL</th>
            <th>Password</th>
            <th>State</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr key={instance.id}>
            <td>
              {instance.rootId}/{instance.relativePath || "—"}
            </td>
            <td>
              {instance.proxyUrl ? (
                <a href={instance.proxyUrl} target="_blank" rel="noreferrer">
                  {instance.proxyUrl.replace(/^https?:\/\//, "")}
                </a>
              ) : instance.port ? (
                <a href={`http://localhost:${instance.port}`} target="_blank" rel="noreferrer">
                  localhost:{instance.port}
                </a>
              ) : (
                "—"
              )}
            </td>
            <td>
              <code>{instance.password}</code>
            </td>
            <td>{instance.state}</td>
            <td>
              <button className="stop-btn" disabled={stopping} onClick={stop}>
                {stopping ? "Stopping…" : "Stop"}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unknown error";
}