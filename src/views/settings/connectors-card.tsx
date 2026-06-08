import { useId, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Icon } from "../../lib/icon";
import { formatRelativeTime } from "../../lib/relative-time";
import { useConnectors } from "../../lib/use-connectors";
import { withPopoverPinned } from "../../lib/use-backup";
import { useFocusTrap } from "../../lib/use-focus-trap";
import {
  clearConnectorSecret,
  installConnectorManifest,
  listConnectorProjects,
  listConnectorTasks,
  previewConnectorManifest,
  setConnectorSecret,
  type Connector,
  type ConnectorCapability,
  type ConnectorKind,
  type ConnectorManifest,
  type RemoteProject,
  type RemoteTask,
} from "../../lib/ipc";

const CAPABILITY: Record<ConnectorCapability, { label: string; hint: string }> =
  {
    network: { label: "Network", hint: "Makes network requests" },
    secrets: { label: "Secrets", hint: "Stores credentials in your keychain" },
  };

function describeKind(kind: ConnectorKind): string {
  if ("file" in kind) return `Local file · ${kind.file.format}`;
  if ("http" in kind) {
    try {
      return `Remote · ${new URL(kind.http.baseUrl).host}`;
    } catch {
      return "Remote";
    }
  }
  // Forward-compat: a kind this build's type doesn't model yet degrades to
  // a generic label instead of crashing.
  return "Connector";
}

/** Shown when a connector list came from the offline cache because the remote
 *  was unreachable — so the user knows the data may be out of date. The cache
 *  only falls back on genuine connectivity failures (a rejected token or bad
 *  response surfaces as an error instead), so "couldn't reach" is accurate. */
function StaleNote({ fetchedAt }: { fetchedAt: string | null }) {
  return (
    <p className="connector-stale" role="status">
      <Icon name="info" size={12} />
      Showing cached data
      {fetchedAt ? ` from ${formatRelativeTime(fetchedAt)}` : ""} — couldn’t
      reach the connector.
    </p>
  );
}

/** "Add connector" — pick a manifest file, preview what it would install
 *  (name, host, capabilities), and install on consent (#110). The picker is
 *  a native dialog, so the popover is pinned for its duration (it steals
 *  focus, which would otherwise hide the popover — see `withPopoverPinned`).
 *  Installing copies the manifest into Cairn's connectors dir and hot-reloads
 *  the list; nothing is written until the user confirms. */
function AddConnector({
  onInstalled,
}: {
  onInstalled: (next: Connector[]) => void;
}) {
  const [pending, setPending] = useState<{
    path: string;
    manifest: ConnectorManifest;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  // Escape/backdrop close the dialog even mid-install — the install
  // completes and refreshes the list regardless; hiding the modal just
  // stops blocking the UI.
  const trap = useFocusTrap(() => setPending(null));

  function close() {
    setPending(null);
    setError(null);
  }

  async function pick() {
    setError(null);
    try {
      const path = await withPopoverPinned(() =>
        open({
          title: "Add a connector",
          multiple: false,
          directory: false,
          filters: [{ name: "Connector manifest", extensions: ["json"] }],
        }),
      );
      // `multiple: false` yields a string or null; guard both.
      if (typeof path !== "string") return;
      const manifest = await previewConnectorManifest(path);
      if (manifest) setPending({ path, manifest });
    } catch (e) {
      setError(String(e));
    }
  }

  async function install(chosen: {
    path: string;
    manifest: ConnectorManifest;
  }) {
    setBusy(true);
    setError(null);
    try {
      onInstalled(await installConnectorManifest(chosen.path));
      setPending(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="connector-add">
      <button type="button" className="link-btn" onClick={() => void pick()}>
        <Icon name="plus" size={12} /> Add connector
      </button>
      {error && !pending && (
        <p className="privacy-banner privacy-banner--error" role="alert">
          Couldn’t add the connector: {error}
        </p>
      )}
      {pending && (
        <div
          className="modal-overlay"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
          <div
            ref={trap.ref}
            className="modal connector-consent"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onKeyDown={trap.onKeyDown}
          >
            <header className="modal-head">
              <h2 id={titleId} className="modal-title">
                Add {pending.manifest.name}?
              </h2>
            </header>
            <div className="modal-body">
              <p className="connector-kind">
                {describeKind(pending.manifest.kind)}
              </p>
              <p className="cap-badges">
                {pending.manifest.capabilities.length === 0 ? (
                  <span className="cap-badge cap-badge--local">
                    Local — no network or secrets
                  </span>
                ) : (
                  pending.manifest.capabilities.map((cap) => (
                    <span
                      key={cap}
                      className="cap-badge"
                      title={CAPABILITY[cap].hint}
                      aria-label={`${CAPABILITY[cap].label}: ${CAPABILITY[cap].hint}`}
                    >
                      {CAPABILITY[cap].label}
                    </span>
                  ))
                )}
              </p>
              <p className="connector-muted">
                Installs into Cairn; you can disable or remove it later.
              </p>
              {error && (
                <p
                  className="privacy-banner privacy-banner--error"
                  role="alert"
                >
                  {error}
                </p>
              )}
            </div>
            <footer className="modal-foot">
              <span className="spacer" />
              <button
                type="button"
                className="btn btn--ghost"
                onClick={close}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void install(pending)}
                disabled={busy}
              >
                Install
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}

/** Settings → Connectors (#110). Lists each loaded PM connector with the
 *  capabilities it declared, and lets you browse — lazily — its projects
 *  and their tasks. Read-only this session (import + per-connector
 *  enable/disable land later). Hides when there are no connectors and no
 *  error (the browser dev harness, or none configured). */
export function ConnectorsCard() {
  const { connectors, error, busyId, replace, toggleEnabled } = useConnectors();

  if (connectors.length === 0 && !error) return null;

  return (
    <section
      className="settings-block"
      aria-label="Connectors"
      data-section="connectors"
    >
      <h3 className="settings-h">Connectors</h3>
      <p className="settings-sub">
        Project-management tools Cairn reads your tasks from, so you can
        attribute time to them.
      </p>
      <AddConnector onInstalled={replace} />
      {error && (
        <p className="privacy-banner privacy-banner--error" role="alert">
          {connectors.length === 0
            ? `Couldn’t load connectors: ${error}`
            : `Couldn’t update the connector: ${error}`}
        </p>
      )}
      <ul className="intg-list">
        {connectors.map((connector) => (
          <ConnectorRow
            key={connector.id}
            connector={connector}
            busy={busyId === connector.id}
            onSecretChange={replace}
            onToggleEnabled={toggleEnabled}
          />
        ))}
      </ul>
    </section>
  );
}

function ConnectorRow({
  connector,
  busy,
  onSecretChange,
  onToggleEnabled,
}: {
  connector: Connector;
  busy: boolean;
  onSecretChange: (next: Connector[]) => void;
  onToggleEnabled: (id: string, next: boolean) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [projects, setProjects] = useState<RemoteProject[] | null>(null);
  const [stale, setStale] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelId = `connector-${connector.id}-projects`;

  async function toggle() {
    const next = !expanded;
    setExpanded(next);
    // Fetch on first expand. A failed load (null) or a stale cache hit both
    // re-fetch on re-expand so a recovered connector shows live data again;
    // a fresh success does not re-fetch.
    if (next && (projects === null || stale) && !loading) {
      setLoading(true);
      setError(null);
      try {
        const res = await listConnectorProjects(connector.id);
        setProjects(res.items);
        setStale(res.stale);
        setFetchedAt(res.fetchedAt);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    }
  }

  return (
    <li
      className="connector-row"
      data-connector={connector.id}
      data-enabled={connector.enabled}
    >
      <div className="connector-head">
        <button
          type="button"
          className="connector-toggle"
          aria-expanded={expanded}
          aria-controls={expanded ? panelId : undefined}
          onClick={() => void toggle()}
          disabled={!connector.enabled}
        >
          <Icon name={expanded ? "chevron-down" : "chevron-right"} size={14} />
          <Icon name="folder" size={14} />
          <span className="intg-name">{connector.name}</span>
        </button>
        <span className="connector-kind">{describeKind(connector.kind)}</span>
        <span className="cap-badges">
          {connector.capabilities.length === 0 ? (
            <span className="cap-badge cap-badge--local">Local</span>
          ) : (
            connector.capabilities.map((cap) => (
              <span
                key={cap}
                className="cap-badge"
                title={CAPABILITY[cap].hint}
                aria-label={`${CAPABILITY[cap].label}: ${CAPABILITY[cap].hint}`}
              >
                {CAPABILITY[cap].label}
              </span>
            ))
          )}
        </span>
        <button
          type="button"
          className={`tgl${connector.enabled ? " is-on" : ""}`}
          role="switch"
          aria-checked={connector.enabled}
          aria-label={`Enable ${connector.name}`}
          onClick={() => void onToggleEnabled(connector.id, !connector.enabled)}
          disabled={busy}
        >
          <span className="tgl-dot" />
        </button>
      </div>
      <ConnectorSecret connector={connector} onChange={onSecretChange} />
      {expanded && connector.enabled && (
        <div id={panelId} className="connector-panel">
          {loading && <p className="connector-muted">Loading…</p>}
          {error && (
            <p className="privacy-banner privacy-banner--error" role="alert">
              Couldn’t load projects: {error}
            </p>
          )}
          {stale && !loading && <StaleNote fetchedAt={fetchedAt} />}
          {projects && projects.length === 0 && !loading && (
            <p className="connector-muted">No projects.</p>
          )}
          {projects && projects.length > 0 && (
            <ul className="connector-projects">
              {projects.map((project) => (
                <ProjectRow
                  key={project.id}
                  connectorId={connector.id}
                  project={project}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

/** The keychain-token affordance for a connector that needs one. Shows the
 *  current state (Needs token / Token saved) and lets the user set, replace,
 *  or clear it. The token is write-only — it is typed into a masked field,
 *  sent once, and never read back; the command returns the refreshed list so
 *  the state flips without re-reading the secret. Renders nothing for a
 *  connector that needs no token. */
function ConnectorSecret({
  connector,
  onChange,
}: {
  connector: Connector;
  onChange: (next: Connector[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (connector.secret === "notRequired") return null;

  const inputId = `connector-${connector.id}-token`;

  function cancel() {
    setEditing(false);
    setToken("");
    setError(null);
  }

  async function save() {
    // Save is disabled while busy or empty, so this only runs with a real
    // token; trim it so a stray-whitespace credential is never stored.
    const trimmed = token.trim();
    setBusy(true);
    setError(null);
    try {
      onChange(await setConnectorSecret(connector.id, trimmed));
      setToken("");
      setEditing(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    setError(null);
    try {
      onChange(await clearConnectorSecret(connector.id));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="connector-secret" data-state={connector.secret}>
      {editing ? (
        <form
          className="connector-secret-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label htmlFor={inputId} className="connector-secret-label">
            API token
          </label>
          <input
            id={inputId}
            type="password"
            className="field-input connector-secret-input"
            value={token}
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste token"
            disabled={busy}
            onChange={(e) => setToken(e.target.value)}
          />
          <button
            type="submit"
            className="connector-secret-action"
            disabled={busy || token.trim() === ""}
          >
            Save
          </button>
          <button
            type="button"
            className="connector-secret-action connector-secret-action--ghost"
            onClick={cancel}
            disabled={busy}
          >
            Cancel
          </button>
        </form>
      ) : (
        <div className="connector-secret-status">
          <span
            className={`connector-secret-badge connector-secret-badge--${connector.secret}`}
          >
            {connector.secret === "missing" ? "Needs token" : "Token saved"}
          </span>
          <button
            type="button"
            className="connector-secret-action"
            onClick={() => setEditing(true)}
            disabled={busy}
          >
            {connector.secret === "missing" ? "Set token" : "Replace"}
          </button>
          {connector.secret === "set" && (
            <button
              type="button"
              className="connector-secret-action connector-secret-action--ghost"
              onClick={() => void clear()}
              disabled={busy}
            >
              Clear
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="privacy-banner privacy-banner--error" role="alert">
          Couldn’t update token: {error}
        </p>
      )}
    </div>
  );
}

function ProjectRow({
  connectorId,
  project,
}: {
  connectorId: string;
  project: RemoteProject;
}) {
  const [expanded, setExpanded] = useState(false);
  const [tasks, setTasks] = useState<RemoteTask[] | null>(null);
  const [stale, setStale] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelId = `project-${connectorId}-${project.id}-tasks`;

  async function toggle() {
    const next = !expanded;
    setExpanded(next);
    // null (failed) or a stale cache hit re-fetch on re-expand; a fresh
    // success does not. See ConnectorRow.toggle.
    if (next && (tasks === null || stale) && !loading) {
      setLoading(true);
      setError(null);
      try {
        const res = await listConnectorTasks(connectorId, project.id);
        setTasks(res.items);
        setStale(res.stale);
        setFetchedAt(res.fetchedAt);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    }
  }

  return (
    <li className="connector-project" data-project={project.id}>
      <button
        type="button"
        className="connector-toggle"
        aria-expanded={expanded}
        aria-controls={expanded ? panelId : undefined}
        onClick={() => void toggle()}
      >
        <Icon name={expanded ? "chevron-down" : "chevron-right"} size={12} />
        <span>{project.name}</span>
      </button>
      {expanded && (
        <div id={panelId} className="connector-panel">
          {loading && <p className="connector-muted">Loading…</p>}
          {error && (
            <p className="privacy-banner privacy-banner--error" role="alert">
              Couldn’t load tasks: {error}
            </p>
          )}
          {stale && !loading && <StaleNote fetchedAt={fetchedAt} />}
          {tasks && tasks.length === 0 && !loading && (
            <p className="connector-muted">No tasks.</p>
          )}
          {tasks && tasks.length > 0 && (
            <ul className="connector-tasks">
              {tasks.map((task) => (
                <li
                  key={task.id}
                  className="connector-task"
                  data-done={task.done}
                >
                  {task.done && <Icon name="check" size={12} />}
                  <span className={task.done ? "connector-task--done" : ""}>
                    {task.label}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}
