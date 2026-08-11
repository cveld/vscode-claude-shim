import { useEffect, useState } from "react";
import {
  ApiError,
  getDiagnostics,
  getInstance,
  getTarget,
  launchInstance,
  stopInstance,
  type Diagnostics,
  type Instance,
  type TargetInfo,
} from "@/simulator-lib/api";
import { pinnedLabel } from "@/simulator-lib/config";

type Props = {
  onChanged: () => void;
};

export default function SimulatorTargetCard({ onChanged }: Props) {
  const [target, setTarget] = useState<TargetInfo | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [targetError, setTargetError] = useState<string | null>(null);
  const [instance, setInstance] = useState<Instance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getTarget()
      .then(setTarget)
      .catch((err) => setTargetError(describeError(err)));

    getDiagnostics()
      .then(setDiagnostics)
      .catch((err) => setError(describeError(err)));
  }, []);

  useEffect(() => {
    if (!target) return;

    getInstance()
      .then(setInstance)
      .catch((err) => setError(describeError(err)));

    const interval = setInterval(() => {
      getInstance()
        .then(setInstance)
        .catch(() => {});
    }, 5000);

    return () => clearInterval(interval);
  }, [target]);

  async function launch() {
    setBusy(true);
    setError(null);
    try {
      const started = await launchInstance();
      setInstance(started);
      onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    setError(null);
    try {
      await stopInstance();
      setInstance(null);
      onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  if (targetError) {
    return (
      <section className="panel">
        <p className="error-text">{targetError}</p>
      </section>
    );
  }

  if (!target) {
    return (
      <section className="panel">
        <p className="muted">Resolving simulator target…</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="target-card">
        <span className="target-icon">{"\u{1F9EA}"}</span>
        <div className="target-info">
          <div className="target-name">{pinnedLabel()}</div>
          <div className="target-root">
            {target.rootId}/{target.relativePath || "—"}
          </div>
        </div>
        <div className="target-actions">
          {instance ? (
            <button className="stop-btn" disabled={busy} onClick={stop}>
              {busy ? "Stopping…" : "Stop simulator"}
            </button>
          ) : (
            <button className="launch-btn" disabled={busy} onClick={launch}>
              {busy ? "Starting…" : "Start simulator"}
            </button>
          )}
        </div>
      </div>

      <p className="muted" style={{ marginTop: "0.5rem" }}>
        Pinned workspace: <code>{target.hostPath}</code>
      </p>

      {instance && instance.port ? (
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          Active protocol endpoint: <code>ws://127.0.0.1:{instance.port}</code>
        </p>
      ) : null}

      {diagnostics ? (
        <div className="diagnostics-inline">
          <div className="diagnostic-pill">Transport: <code>{diagnostics.transport}</code></div>
          <div className="diagnostic-pill">Lock files: <code>{diagnostics.lockFileDir}</code></div>
          <div className="diagnostic-pill">Host ~/.claude writable: <strong>{diagnostics.claudeDirWritable ? "yes" : "no"}</strong></div>
        </div>
      ) : null}

      {error ? <p className="error-text">{error}</p> : null}
    </section>
  );
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unknown error";
}
