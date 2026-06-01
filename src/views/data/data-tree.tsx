import { useCallback, useEffect, useState } from "react";
import { Icon } from "../../lib/icon";
import { Empty } from "../../lib/components";
import { cbColor } from "../../lib/colorblind";
import { useColorblindEnabled } from "../../lib/use-colorblind";
import { deleteTask, inTauri, listTasks, saveTask } from "../../lib/ipc";
import type { Client, Project, Task } from "../../lib/types";
import { TASKS as FIXTURE_TASKS } from "../../test-fixtures/data";
import type { UseProjects } from "../../lib/use-projects";
import type { UseClients } from "../../lib/use-clients";

const PROJECT_COLORS = [
  "#81b29a",
  "#f2cc8f",
  "#e07a5f",
  "#9a9bb0",
  "#c8b8e0",
  "#6d9dc5",
];

type Run = (fn: () => Promise<unknown>) => Promise<void>;

interface DataTreeProps {
  projects: UseProjects;
  clients: UseClients;
  run: Run;
}

interface ClientGroup {
  clientId: string | null;
  client: Client | null;
  projects: Project[];
}

function buildGroups(projects: Project[], clients: Client[]): ClientGroup[] {
  const clientMap = new Map(clients.map((c) => [c.id, c]));
  const seen = new Set<string | null>();
  const order: Array<string | null> = [];

  for (const p of projects) {
    if (!seen.has(p.clientId)) {
      seen.add(p.clientId);
      order.push(p.clientId);
    }
  }

  const grouped = new Map<string | null, Project[]>();
  for (const p of projects) {
    const list = grouped.get(p.clientId) ?? [];
    list.push(p);
    grouped.set(p.clientId, list);
  }

  return order.map((clientId) => ({
    clientId,
    client: clientId ? (clientMap.get(clientId) ?? null) : null,
    projects: grouped.get(clientId)!,
  }));
}

interface TasksForProjectProps {
  project: Project;
  run: Run;
}

function TasksForProject({ project, run }: TasksForProjectProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const refresh = useCallback(async () => {
    if (!inTauri) {
      setTasks(FIXTURE_TASKS.filter((t) => t.projectId === project.id));
      return;
    }
    try {
      setTasks(await listTasks(project.id));
    } catch {
      setTasks([]);
    }
  }, [project.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = async () => {
    const name = draft.trim();
    if (!name) return;
    setDraft("");
    await run(async () => {
      if (!inTauri) {
        const local: Task = {
          id: `local-task-${name.toLowerCase().replace(/\s+/g, "-")}`,
          projectId: project.id,
          name,
          archived: false,
        };
        setTasks((prev) =>
          prev.some((t) => t.id === local.id) ? prev : [...prev, local],
        );
        return;
      }
      const saved = await saveTask({ projectId: project.id, name });
      setTasks((prev) => [...prev.filter((t) => t.id !== saved.id), saved]);
    });
  };

  return (
    <div className="tree-tasks">
      {tasks.length === 0 ? (
        <Empty title="No tasks" body="Add tasks below." tone="soft" />
      ) : (
        <ul className="data-list tree-task-list" role="list">
          {tasks.map((t) => (
            <li key={t.id} className="data-row tree-task-row">
              <span className="data-name">{t.name}</span>
              <span className="data-row-actions" style={{ marginLeft: "auto" }}>
                {confirmId === t.id ? (
                  <>
                    <span className="data-confirm-text">Delete?</span>
                    <button
                      type="button"
                      className="link-btn link-btn--danger"
                      onClick={() => {
                        setConfirmId(null);
                        void run(async () => {
                          if (inTauri) await deleteTask(t.id);
                          setTasks((prev) => prev.filter((x) => x.id !== t.id));
                        });
                      }}
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => setConfirmId(null)}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="link-btn link-btn--danger"
                    aria-label={`Delete ${t.name}`}
                    onClick={() => setConfirmId(t.id)}
                  >
                    Delete
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="data-add-row tree-add-task">
        <input
          className="field-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void add();
            }
          }}
          placeholder="New task name"
          aria-label={`New task for ${project.name}`}
        />
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => void add()}
          disabled={!draft.trim()}
        >
          Add
        </button>
      </div>
    </div>
  );
}

interface ProjectNodeProps {
  project: Project;
  run: Run;
  onDelete: (id: string) => void;
}

function ProjectNode({ project, run, onDelete }: ProjectNodeProps) {
  const cbEnabled = useColorblindEnabled();
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <li
      className="tree-project"
      role="treeitem"
      aria-expanded={expanded}
    >
      <div className="tree-project-row">
        <button
          type="button"
          className="tree-expand-btn"
          aria-label={expanded ? `Collapse ${project.name}` : `Expand ${project.name}`}
          onClick={() => setExpanded((v) => !v)}
        >
          <Icon
            name={expanded ? "chevron-down" : "chevron-right"}
            size={12}
          />
        </button>
        <span
          className="proj-dot"
          style={{ background: cbColor(project.color, cbEnabled) }}
        />
        <span className="data-name">{project.name}</span>
        <span className="data-row-actions">
          {confirmDelete ? (
            <>
              <span className="data-confirm-text">Delete?</span>
              <button
                type="button"
                className="link-btn link-btn--danger"
                onClick={() => {
                  setConfirmDelete(false);
                  onDelete(project.id);
                }}
              >
                Delete
              </button>
              <button
                type="button"
                className="link-btn"
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className="link-btn link-btn--danger"
              aria-label={`Delete ${project.name}`}
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </button>
          )}
        </span>
      </div>
      {expanded && (
        <div className="tree-project-children">
          <TasksForProject project={project} run={run} />
        </div>
      )}
    </li>
  );
}

interface ClientGroupNodeProps {
  group: ClientGroup;
  projects: UseProjects;
  run: Run;
}

function ClientGroupNode({ group, projects, run }: ClientGroupNodeProps) {
  const [draft, setDraft] = useState("");

  const addProject = async () => {
    const name = draft.trim();
    if (!name) return;
    setDraft("");
    const color =
      PROJECT_COLORS[projects.projects.length % PROJECT_COLORS.length];
    await run(() =>
      projects.create({ name, color, clientId: group.clientId }),
    );
  };

  const deleteProject = useCallback(
    (id: string) => run(() => projects.remove(id)),
    [run, projects],
  );

  const groupLabel = group.client ? group.client.name : "No client";

  return (
    <li
      className="tree-client"
      role="treeitem"
      aria-label={groupLabel}
    >
      <div className="tree-client-label">
        <span className="data-name">{groupLabel}</span>
        <span className="data-meta tree-client-count">
          {group.projects.length} project
          {group.projects.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul
        className="tree-project-list"
        role="group"
        aria-label={`Projects under ${groupLabel}`}
      >
        {group.projects.map((p) => (
          <ProjectNode
            key={p.id}
            project={p}
            run={run}
            onDelete={deleteProject}
          />
        ))}
      </ul>
      <div className="data-add-row tree-add-project">
        <input
          className="field-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void addProject();
            }
          }}
          placeholder="New project name"
          aria-label={`New project under ${groupLabel}`}
        />
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => void addProject()}
          disabled={!draft.trim()}
        >
          Add
        </button>
      </div>
    </li>
  );
}

export function DataTree({ projects, clients, run }: DataTreeProps) {
  const groups = buildGroups(projects.projects, clients.clients);

  if (groups.length === 0) {
    return (
      <Empty
        title="No projects yet"
        body="Add a project in the Sections view to get started."
        tone="soft"
      />
    );
  }

  return (
    <ul
      className="tree-root"
      role="tree"
      aria-label="Client, project, and task hierarchy"
    >
      {groups.map((group) => (
        <ClientGroupNode
          key={group.clientId ?? "__no_client__"}
          group={group}
          projects={projects}
          run={run}
        />
      ))}
    </ul>
  );
}

export { buildGroups };

export type { ClientGroup };
