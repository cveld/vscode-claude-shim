// Pinned folder card with launch/open/stop actions.
// Resolves the pinned target via /api/target and polls the launcher API
// for instance state.

import { useEffect, useState } from "react";
import { ApiError, getInstance, launchInstance, stopInstance, type Instance } from "@/mini-lib/api";
import { pinnedLabel } from "@/mini-lib/config";

type TargetInfo = {
  rootId: string;
  relativePath: string;
  hostPath: string;
  type: "folder" | "workspace";
};

type Props = {
  onChanged: () => void;
};

export default function PinnedTargetCard({ onChanged }: Props) {
  const [target, setTarget] = useState<TargetInfo | null>(null);
  const [targetError, setTargetError] = useState<string | null>(null);
  const [instance, setInstance] = useState<Instance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Resolve target once on mount
  useEffect(() => {
    fetch("/api/target")
      .then((r) => {
        if (!r.ok) throw new ApiError(r.status, "Failed to resolve target");
        return r.json();
      })
      .then(setTarget)
      .catch((err) => setTargetError(describeError(err)));
  }, []);

  // Poll instance status
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
    if (!target) return;
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
    if (!instance) return;
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
        <p className="muted">Resolving pinned target…</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="target-card">
        <span className="target-icon">{"\u{1F4C1}"}</span>
        <div className="target-info">
          <div className="target-name">{pinnedLabel()}</div>
          <div className="target-root">
            {target.rootId}/{target.relativePath || "—"}
          </div>
        </div>
        <div className="target-actions">
          {instance ? (
            <>
              {openUrl(instance) ? (
                <a className="open-btn" href={openUrl(instance)!} target="_blank" rel="noreferrer">
                  Open
                </a>
              ) : null}
              <button className="stop-btn" disabled={busy} onClick={stop}>
                {busy ? "Stopping…" : "Stop"}
              </button>
            </>
          ) : (
            <button className="launch-btn" disabled={busy} onClick={launch}>
              {busy ? "Launching…" : "Launch"}
            </button>
          )}
        </div>
      </div>
      {instance ? (
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          Running on{" "}
          {instance.proxyUrl ? (
            <a href={instance.proxyUrl} target="_blank" rel="noreferrer">
              {instance.proxyUrl.replace(/^https?:\/\//, "")}
            </a>
          ) : (
            <span title="Caddy is not reachable, so only the direct port link is available">
              no stable URL
            </span>
          )}
          {instance.port ? (
            <>
              {" — direct: "}
              <a href={`http://localhost:${instance.port}`} target="_blank" rel="noreferrer">
                localhost:{instance.port}
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}

// The proxy URL is stable across restarts, so it is what Open should use; the published port is the
// fallback for when Caddy is not running (see lib/proxy.ts).
function openUrl(instance: Instance): string | null {
  if (instance.proxyUrl) return instance.proxyUrl;
  return instance.port ? `http://localhost:${instance.port}` : null;
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unknown error";
}