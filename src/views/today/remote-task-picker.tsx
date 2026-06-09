import { useEffect, useId, useState } from "react";
import {
  emptyList,
  listConnectorProjects,
  listConnectorTasks,
  type CachedList,
  type Connector,
  type RemoteProject,
  type RemoteTask,
} from "../../lib/ipc";

/** A connector task the user picked, ready to attribute an entry to (#110). */
export interface PickedRemoteTask {
  connectorId: string;
  remoteId: string;
  label: string;
  url: string | null;
  remoteProjectName: string | null;
}

interface Props {
  /** Enabled connectors to choose from (the caller filters to enabled). */
  connectors: Connector[];
  onPick: (picked: PickedRemoteTask) => void;
  onCancel: () => void;
}

/** Run a cached connector read into `set`, tracking the shared loading/error
 *  state and ignoring a resolution after the inputs changed (one `cancelled`
 *  check, so the late-resolution path is a single branch). Returns the effect
 *  cleanup. */
function loadInto<T>(
  kind: "projects" | "tasks",
  fetch: () => Promise<CachedList<T>>,
  set: (list: CachedList<T>) => void,
  setLoading: (l: "projects" | "tasks" | null) => void,
  setError: (e: string | null) => void,
): () => void {
  let cancelled = false;
  setLoading(kind);
  setError(null);
  type Settled = { list: CachedList<T> } | { error: string };
  void fetch()
    .then<Settled, Settled>(
      (list) => ({ list }),
      (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }),
    )
    .then((res) => {
      if (cancelled) return;
      if ("error" in res) setError(res.error);
      else set(res.list);
      setLoading(null);
    });
  return () => {
    cancelled = true;
  };
}

/** Drill connector → project → task and hand the chosen task back via
 *  `onPick`. Each level lazily loads through the offline cache and surfaces a
 *  "showing offline copy" note when the list is stale. Read-only — picking a
 *  task does not write anything; the caller attributes on submit. */
export function RemoteTaskPicker({ connectors, onPick, onCancel }: Props) {
  const connectorFieldId = useId();
  const projectFieldId = useId();
  const taskFieldId = useId();

  const [connectorId, setConnectorId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projects, setProjects] =
    useState<CachedList<RemoteProject>>(emptyList());
  const [tasks, setTasks] = useState<CachedList<RemoteTask>>(emptyList());
  const [loading, setLoading] = useState<"projects" | "tasks" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!connectorId) {
      setProjects(emptyList());
      return;
    }
    return loadInto(
      "projects",
      () => listConnectorProjects(connectorId),
      setProjects,
      setLoading,
      setError,
    );
  }, [connectorId]);

  useEffect(() => {
    if (!connectorId || !projectId) {
      setTasks(emptyList());
      return;
    }
    return loadInto(
      "tasks",
      () => listConnectorTasks(connectorId, projectId),
      setTasks,
      setLoading,
      setError,
    );
  }, [connectorId, projectId]);

  function choose(remoteId: string) {
    const task = tasks.items.find((t) => t.id === remoteId);
    if (!task) return;
    onPick({
      connectorId,
      remoteId: task.id,
      label: task.label,
      url: task.url,
      remoteProjectName: projectName,
    });
  }

  if (connectors.length === 0) {
    return (
      <div className="remote-picker" role="group" aria-label="Link a task">
        <p className="remote-picker-empty">
          No connectors enabled. Add or enable one in Settings → Connectors.
        </p>
        <button type="button" className="link-btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="remote-picker" role="group" aria-label="Link a task">
      <label className="field-label" htmlFor={connectorFieldId}>
        Connector
      </label>
      <select
        id={connectorFieldId}
        className="field-input"
        value={connectorId}
        onChange={(e) => {
          setConnectorId(e.target.value);
          setProjectId("");
          setProjectName("");
          setTasks(emptyList());
        }}
      >
        <option value="">Choose a connector…</option>
        {connectors.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>

      {connectorId && (
        <>
          <label className="field-label" htmlFor={projectFieldId}>
            Project
            {projects.stale && (
              <span className="remote-picker-stale"> · offline copy</span>
            )}
          </label>
          <select
            id={projectFieldId}
            className="field-input"
            value={projectId}
            disabled={loading === "projects"}
            onChange={(e) => {
              setProjectId(e.target.value);
              setProjectName(e.target.options[e.target.selectedIndex].text);
              setTasks(emptyList());
            }}
          >
            <option value="">Choose a project…</option>
            {projects.items.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </>
      )}

      {connectorId && projectId && (
        <>
          <label className="field-label" htmlFor={taskFieldId}>
            Task
            {tasks.stale && (
              <span className="remote-picker-stale"> · offline copy</span>
            )}
          </label>
          <select
            key={projectId}
            id={taskFieldId}
            className="field-input"
            defaultValue=""
            disabled={loading === "tasks"}
            onChange={(e) => choose(e.target.value)}
          >
            <option value="">Choose a task to link…</option>
            {tasks.items.map((t) => (
              <option key={t.id} value={t.id}>
                {t.done ? "✓ " : ""}
                {t.label}
              </option>
            ))}
          </select>
        </>
      )}

      {error && (
        <p className="remote-picker-error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="link-btn" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
