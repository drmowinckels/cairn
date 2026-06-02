import { useEffect, useState } from "react";
import { Icon } from "../../lib/icon";
import {
  getGitDiscoveryRoots,
  setGitDiscoveryRoots,
  type GitWatcherStatus,
} from "../../lib/ipc";

interface Props {
  onClose: () => void;
  onSaved: (status: GitWatcherStatus) => void;
}

export function GitRootsManager({ onClose, onSaved }: Props) {
  const [roots, setRoots] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getGitDiscoveryRoots()
      .then((r) => {
        if (!cancelled) {
          setRoots(r);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(String(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const addDraft = () => {
    const value = draft.trim();
    if (!value) return;
    setDraft("");
    setRoots((rs) => (rs.includes(value) ? rs : [...rs, value]));
  };

  const removeRoot = (target: string) =>
    setRoots((rs) => rs.filter((r) => r !== target));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const status = await setGitDiscoveryRoots(roots);
      onSaved(status);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const resetToDefaults = async () => {
    setBusy(true);
    setError(null);
    try {
      // An empty list clears the override; the backend then reports the
      // built-in defaults, which we reload to show the user.
      const status = await setGitDiscoveryRoots([]);
      const fresh = await getGitDiscoveryRoots();
      setRoots(fresh);
      onSaved(status);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-scrim"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal-card git-roots-mgr"
        role="dialog"
        aria-modal="true"
        aria-label="Configure git discovery roots"
      >
        <header className="modal-head">
          <h2>Git discovery roots</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close"
            onClick={onClose}
          >
            <Icon name="x" size={14} />
          </button>
        </header>

        <p className="modal-sub">
          Folders Cairn scans for git repositories to watch for branch
          changes. Use <code>~</code> for your home folder. Changes apply
          immediately; newly added folders are fully resolved after the next
          launch.
        </p>

        {error && (
          <div className="privacy-banner privacy-banner--error" role="alert">
            <Icon name="x" size={13} />
            <span>{error}</span>
          </div>
        )}

        <ul className="git-roots-list" aria-label="Discovery roots">
          {loading && <li className="git-roots-empty">Loading…</li>}
          {!loading && roots.length === 0 && (
            <li className="git-roots-empty">
              No roots configured — Cairn watches nothing.
            </li>
          )}
          {roots.map((r) => (
            <li key={r} className="git-root-row">
              <span className="git-root-path mono">{r}</span>
              <button
                type="button"
                className="link-btn"
                onClick={() => removeRoot(r)}
                aria-label={`Remove ${r}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>

        <div className="git-roots-add">
          <label className="git-roots-field">
            <span>Add a folder</span>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addDraft();
                }
              }}
              placeholder="~/code or /path/to/projects"
              aria-label="New discovery root"
            />
          </label>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={addDraft}
            disabled={!draft.trim()}
          >
            Add
          </button>
        </div>

        <footer className="git-roots-foot">
          <button
            type="button"
            className="link-btn"
            onClick={resetToDefaults}
            disabled={busy}
          >
            Reset to defaults
          </button>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={save}
            disabled={busy || loading}
          >
            <Icon name="check" size={12} /> {busy ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}
