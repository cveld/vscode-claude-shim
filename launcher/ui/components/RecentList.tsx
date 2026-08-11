import { useEffect, useState } from "react";
import { ApiError, getRecent, getRoots, launchByRoot, type RecentEntry, type Root } from "../lib/api";

type Props = {
  refreshSignal: number;
  onLaunched: () => void;
};

export default function RecentList({ refreshSignal, onLaunched }: Props) {
  const [entries, setEntries] = useState<RecentEntry[]>([]);
  const [roots, setRoots] = useState<Root[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState<string | null>(null);

  useEffect(() => {
    getRoots()
      .then(setRoots)
      .catch(() => {});
  }, []);

  useEffect(() => {
    getRecent()
      .then(setEntries)
      .catch((err) => setError(describeError(err)));
  }, [refreshSignal]);

  function rootLabel(rootId: string) {
    return roots.find((r) => r.id === rootId)?.label ?? rootId;
  }

  async function launch(entry: RecentEntry) {
    const key = entryKey(entry);
    setLaunching(key);
    setError(null);
    try {
      await launchByRoot(entry.rootId, entry.relativePath);
      onLaunched();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLaunching(null);
    }
  }

  if (entries.length === 0) return null;

  return (
    <section className="panel">
      <h2>Recently launched</h2>
      <ul className="entry-list">
        {entries.map((entry) => {
          const key = entryKey(entry);
          return (
            <li className="entry-row" key={key}>
              <span className="entry-icon">{entry.type === "workspace" ? "\u{1F5C2}" : "\u{1F4C1}"}</span>
              <span className="entry-name">
                {rootLabel(entry.rootId)}
                {entry.relativePath ? `/${entry.relativePath}` : ""}
              </span>
              <span className="muted">{formatRelativeTime(entry.lastLaunchedAt)}</span>
              <button className="launch-btn" disabled={launching === key} onClick={() => launch(entry)}>
                {launching === key ? "Launching…" : "Launch"}
              </button>
            </li>
          );
        })}
      </ul>
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}

function entryKey(entry: RecentEntry): string {
  return `${entry.rootId}/${entry.relativePath}`;
}

function formatRelativeTime(ts: number): string {
  const minutes = Math.round((Date.now() - ts) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unknown error";
}
