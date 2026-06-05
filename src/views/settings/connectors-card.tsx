import { useState } from "react";
import { Icon } from "../../lib/icon";
import { useConnectors } from "../../lib/use-connectors";
import {
  listConnectorProjects,
  listConnectorTasks,
  type Connector,
  type ConnectorCapability,
  type ConnectorKind,
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
  // Forward-compat: a kind this build's type doesn't model yet (e.g. a
  // future `http`) degrades to a generic label instead of crashing.
  return "Connector";
}

/** Settings → Connectors (#110). Lists each loaded PM connector with the
 *  capabilities it declared, and lets you browse — lazily — its projects
 *  and their tasks. Read-only this session (import + per-connector
 *  enable/disable land later). Hides when there are no connectors and no
 *  error (the browser dev harness, or none configured). */
export function ConnectorsCard() {
  const { connectors, error } = useConnectors();

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
      {error && (
        <p className="privacy-banner privacy-banner--error" role="alert">
          Couldn’t load connectors: {error}
        </p>
      )}
      <ul className="intg-list">
        {connectors.map((connector) => (
          <ConnectorRow key={connector.id} connector={connector} />
        ))}
      </ul>
    </section>
  );
}

function ConnectorRow({ connector }: { connector: Connector }) {
  const [expanded, setExpanded] = useState(false);
  const [projects, setProjects] = useState<RemoteProject[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelId = `connector-${connector.id}-projects`;

  async function toggle() {
    const next = !expanded;
    setExpanded(next);
    // Fetch once on first expand. A failed load leaves `projects` null so
    // re-expanding retries; an empty success ([]) does not re-fetch.
    if (next && projects === null && !loading) {
      setLoading(true);
      setError(null);
      try {
        setProjects(await listConnectorProjects(connector.id));
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    }
  }

  return (
    <li className="connector-row" data-connector={connector.id}>
      <div className="connector-head">
        <button
          type="button"
          className="connector-toggle"
          aria-expanded={expanded}
          aria-controls={expanded ? panelId : undefined}
          onClick={() => void toggle()}
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
      </div>
      {expanded && (
        <div id={panelId} className="connector-panel">
          {loading && <p className="connector-muted">Loading…</p>}
          {error && (
            <p className="privacy-banner privacy-banner--error" role="alert">
              Couldn’t load projects: {error}
            </p>
          )}
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

function ProjectRow({
  connectorId,
  project,
}: {
  connectorId: string;
  project: RemoteProject;
}) {
  const [expanded, setExpanded] = useState(false);
  const [tasks, setTasks] = useState<RemoteTask[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelId = `project-${connectorId}-${project.id}-tasks`;

  async function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (next && tasks === null && !loading) {
      setLoading(true);
      setError(null);
      try {
        setTasks(await listConnectorTasks(connectorId, project.id));
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
