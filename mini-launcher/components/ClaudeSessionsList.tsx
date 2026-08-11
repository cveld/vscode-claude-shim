// Claude chat sessions for the pinned folder.
// Fetches from the mini-launcher's own /api/sessions endpoint which reads
// ~/.claude/projects/<slug>/*.jsonl transcripts.

import { useEffect, useState } from "react";
import {
  ApiError,
  getClaudeSessions,
  openClaudeInSidebar,
  openClaudeSession,
  type ClaudeOpenTarget,
  type ClaudeSession,
} from "@/mini-lib/api";

const POLL_MS = 15000;

type Props = {
  refreshSignal: number;
};

export default function ClaudeSessionsList({ refreshSignal }: Props) {
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openingSessionId, setOpeningSessionId] = useState<string | null>(null);
  const [dockingSidebar, setDockingSidebar] = useState(false);

  async function openSession(sessionId: string, target: ClaudeOpenTarget = "editor") {
    setOpeningSessionId(sessionId);
    setError(null);
    try {
      const result = await openClaudeSession(sessionId, target);
      if (!result.ok || !result.openUrl) {
        throw new Error(result.reason ?? "Could not open Claude session");
      }
      window.open(result.openUrl, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setOpeningSessionId((current) => (current === sessionId ? null : current));
    }
  }

  async function dockInSidebar() {
    setDockingSidebar(true);
    setError(null);
    try {
      const result = await openClaudeInSidebar();
      if (!result.ok || !result.openUrl) {
        throw new Error(result.reason ?? "Could not dock Claude in the side bar");
      }
      window.open(result.openUrl, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setDockingSidebar(false);
    }
  }

  useEffect(() => {
    getClaudeSessions()
      .then(setSessions)
      .catch((err) => setError(describeError(err)));
  }, [refreshSignal]);

  // Poll less frequently — this reads files from disk, not from an API
  useEffect(() => {
    const interval = setInterval(() => {
      getClaudeSessions()
        .then(setSessions)
        .catch(() => {});
    }, POLL_MS);
    return () => clearInterval(interval);
  }, []);

  return (
    <section className="panel">
      <div className="session-panel-header">
        <h2>Claude sessions</h2>
        <button
          className="sidebar-dock-button"
          disabled={dockingSidebar}
          onClick={() => void dockInSidebar()}
          title="Dock Claude in the side bar with a fresh conversation (use a session's 'Side bar' button to resume a specific one there)"
          type="button"
        >
          {dockingSidebar ? "opening…" : "Open Claude in side bar"}
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {sessions.length === 0 && !error ? (
        <p className="muted">No Claude sessions found for this folder.</p>
      ) : (
        <div className="entry-list">
          {sessions.map((s) => {
            const sessionId = s.id;
            const isOpening = openingSessionId === sessionId;
            const content = (
              <>
                <div className="session-header">
                  <span className="session-title">
                    {s.title ?? s.firstUserMessage ?? s.id}
                  </span>
                  {s.isActive ? <span className="live-badge">live</span> : null}
                </div>
                <div className="session-meta">
                  <span>{s.lastActivity ? relativeTime(s.lastActivity) : "—"}</span>
                  <span>{s.messageCount} messages</span>
                  {s.totalTokensBurned > 0 ? (
                    <span>{formatTokens(s.totalTokensBurned)} tokens</span>
                  ) : null}
                  {s.canOpen ? (
                    isOpening ? <span>opening…</span> : null
                  ) : (
                    <span>instance not running</span>
                  )}
                </div>
              </>
            );

            return (
              <div className="session-row" key={s.id}>
                <div className="session-item">{content}</div>
                {s.canOpen ? (
                  <div className="session-actions">
                    <button
                      className="session-action"
                      disabled={isOpening}
                      onClick={() => void openSession(sessionId, "editor")}
                      title="Resume this session in an editor tab"
                      type="button"
                    >
                      Editor
                    </button>
                    <button
                      className="session-action"
                      disabled={isOpening}
                      onClick={() => void openSession(sessionId, "sidebar")}
                      title="Resume this session in the side bar"
                      type="button"
                    >
                      Side bar
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unknown error";
}
