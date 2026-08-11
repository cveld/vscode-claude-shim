import { useEffect, useState } from "react";
import { ApiError, getShimSettings, putShimSettings } from "../lib/api";

export default function ShimSettings() {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getShimSettings()
      .then((settings) => setText(JSON.stringify(settings, null, 2)))
      .catch((err) => setError(describeError(err)));
  }, []);

  async function save() {
    setError(null);
    setStatus(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setError(`Invalid JSON: ${(err as Error).message}`);
      return;
    }
    setSaving(true);
    try {
      await putShimSettings(parsed);
      setStatus("Saved — takes effect on the next container launch.");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel">
      <h2>Shim settings</h2>
      <p className="subtitle">
        Merged into every container&apos;s ~/.claude/settings.json on launch.
        <code>autoInstallIdeExtension</code> stays forced off regardless of what&apos;s set here.
      </p>
      <textarea
        className="settings-editor"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        rows={20}
      />
      <div className="settings-actions">
        <button className="launch-btn" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </button>
        {status && <span className="muted">{status}</span>}
      </div>
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unknown error";
}
