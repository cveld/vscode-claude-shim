import { useEffect, useState } from "react";
import {
  ApiError,
  browse,
  createFolder,
  getRoots,
  launchByRoot,
  resolvePath,
  type BrowseEntry,
  type Root,
} from "../lib/api";

type Props = {
  onLaunched: () => void;
};

export default function RootBrowser({ onLaunched }: Props) {
  const [roots, setRoots] = useState<Root[]>([]);
  const [rootId, setRootId] = useState<string | null>(null);
  const [segments, setSegments] = useState<string[]>([]);
  const [children, setChildren] = useState<BrowseEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState<string | null>(null);
  const [pasteInput, setPasteInput] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderError, setNewFolderError] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);

  useEffect(() => {
    getRoots()
      .then((r) => {
        setRoots(r);
        if (r.length > 0) setRootId(r[0].id);
      })
      .catch((err) => setError(describeError(err)));
  }, []);

  useEffect(() => {
    if (!rootId) return;
    setError(null);
    browse(rootId, segments.join("/"))
      .then((result) => setChildren(result.children))
      .catch((err) => setError(describeError(err)));
  }, [rootId, segments]);

  function selectRoot(id: string) {
    setRootId(id);
    setSegments([]);
    closeNewFolder();
  }

  function drillInto(name: string) {
    setSegments((prev) => [...prev, name]);
    closeNewFolder();
  }

  function jumpTo(depth: number) {
    setSegments((prev) => prev.slice(0, depth));
    closeNewFolder();
  }

  function closeNewFolder() {
    setNewFolderOpen(false);
    setNewFolderName("");
    setNewFolderError(null);
  }

  async function submitNewFolder() {
    if (!rootId || !newFolderName.trim()) return;
    setCreatingFolder(true);
    setNewFolderError(null);
    try {
      await createFolder(rootId, currentRelativePath, newFolderName.trim());
      const result = await browse(rootId, currentRelativePath);
      setChildren(result.children);
      closeNewFolder();
    } catch (err) {
      setNewFolderError(describeError(err));
    } finally {
      setCreatingFolder(false);
    }
  }

  async function launch(relativePath: string) {
    if (!rootId) return;
    setLaunching(relativePath);
    setError(null);
    try {
      await launchByRoot(rootId, relativePath);
      onLaunched();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLaunching(null);
    }
  }

  async function submitPaste() {
    if (!pasteInput.trim()) return;
    setPasteError(null);
    try {
      const resolved = await resolvePath(pasteInput);
      if (resolved.type === "folder") {
        setRootId(resolved.rootId);
        setSegments(resolved.relativePath ? resolved.relativePath.split("/") : []);
        setPasteInput("");
      } else {
        await launch(resolved.relativePath);
        setPasteInput("");
      }
    } catch (err) {
      setPasteError(describeError(err));
    }
  }

  const currentRelativePath = segments.join("/");
  const currentRootLabel = roots.find((r) => r.id === rootId)?.label ?? rootId;

  return (
    <section className="panel">
      <h2>Browse</h2>

      <div className="root-tabs">
        {roots.map((r) => (
          <button
            key={r.id}
            className={`root-tab${r.id === rootId ? " active" : ""}`}
            onClick={() => selectRoot(r.id)}
          >
            {r.label}
          </button>
        ))}
      </div>

      <div className="breadcrumb">
        <button onClick={() => jumpTo(0)}>{currentRootLabel}</button>
        {segments.map((seg, i) => (
          <span key={i}>
            {" / "}
            <button onClick={() => jumpTo(i + 1)}>{seg}</button>
          </span>
        ))}
      </div>

      <ul className="entry-list">
        {children.map((entry) => {
          const entryPath = currentRelativePath ? `${currentRelativePath}/${entry.name}` : entry.name;
          return (
            <li className="entry-row" key={entry.name}>
              <span className="entry-icon">{entry.type === "workspace" ? "\u{1F5C2}" : "\u{1F4C1}"}</span>
              {entry.type === "folder" ? (
                <button className="entry-name" onClick={() => drillInto(entry.name)}>
                  {entry.name}
                </button>
              ) : (
                <span className="entry-name">{entry.name}</span>
              )}
              <button
                className="launch-btn"
                disabled={launching === entryPath}
                onClick={() => launch(entryPath)}
              >
                {launching === entryPath ? "Launching…" : "Launch"}
              </button>
            </li>
          );
        })}
        {children.length === 0 && <li className="muted">Empty folder.</li>}
      </ul>

      <div className="new-folder-row">
        {newFolderOpen ? (
          <>
            <input
              placeholder="New folder name…"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitNewFolder();
                if (e.key === "Escape") closeNewFolder();
              }}
              autoFocus
            />
            <button className="secondary-btn" disabled={creatingFolder} onClick={submitNewFolder}>
              {creatingFolder ? "Creating…" : "Create"}
            </button>
            <button className="secondary-btn" onClick={closeNewFolder}>
              Cancel
            </button>
          </>
        ) : (
          <button className="secondary-btn" onClick={() => setNewFolderOpen(true)}>
            + New folder
          </button>
        )}
      </div>
      {newFolderError && <p className="error-text">{newFolderError}</p>}

      <button
        className="secondary-btn"
        style={{ marginTop: "0.75rem" }}
        disabled={launching === currentRelativePath}
        onClick={() => launch(currentRelativePath)}
      >
        {launching === currentRelativePath ? "Launching…" : `Launch current folder (${currentRootLabel}${currentRelativePath ? "/" + currentRelativePath : ""})`}
      </button>

      {error && <p className="error-text">{error}</p>}

      <div className="paste-row">
        <input
          placeholder="Paste an absolute path (folder or .code-workspace)…"
          value={pasteInput}
          onChange={(e) => setPasteInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submitPaste()}
        />
        <button className="secondary-btn" onClick={submitPaste}>
          Go
        </button>
      </div>
      {pasteError && <p className="error-text">{pasteError}</p>}
    </section>
  );
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unknown error";
}
