import { useEffect, useState } from "react";
import { ApiError, listInstances, stopInstance, type Instance } from "../lib/api";

const POLL_MS = 5000;

type Props = {
  refreshSignal: number;
};

export default function InstancesList({ refreshSignal }: Props) {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);

  function refresh() {
    listInstances()
      .then(setInstances)
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

  async function stop(id: string) {
    setStopping(id);
    setError(null);
    try {
      await stopInstance(id);
      refresh();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setStopping(null);
    }
  }

  return (
    <section className="panel">
      <h2>Running instances</h2>
      {instances.length === 0 ? (
        <p className="muted">No instances running.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Project</th>
              <th>Type</th>
              <th>URL</th>
              <th>Password</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {instances.map((inst) => (
              <tr key={inst.id}>
                <td>
                  {inst.rootId}/{inst.relativePath || "—"}
                </td>
                <td>{inst.type}</td>
                <td>
                  {inst.port ? (
                    <a href={`http://localhost:${inst.port}`} target="_blank" rel="noreferrer">
                      localhost:{inst.port}
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  <code>{inst.password}</code>
                </td>
                <td>{inst.state}</td>
                <td>
                  <button className="stop-btn" disabled={stopping === inst.id} onClick={() => stop(inst.id)}>
                    {stopping === inst.id ? "Stopping…" : "Stop"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unknown error";
}
