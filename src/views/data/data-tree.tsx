import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../lib/icon";
import { Empty } from "../../lib/components";
import { cbColor } from "../../lib/colorblind";
import { useColorblindEnabled } from "../../lib/use-colorblind";
import { deleteTask, inTauri, listTasks, saveTask } from "../../lib/ipc";
import type { Client, Project, Task } from "../../lib/types";
import { TASKS as FIXTURE_TASKS } from "../../test-fixtures/data";
import type { UseProjects } from "../../lib/use-projects";
import type { UseClients } from "../../lib/use-clients";
import { TREE_NAV_KEYS, treeNavigate, type TreeNode } from "../../lib/tree-nav";

/** Stable treeitem ids. Prefixed so a client and a project can never
 * collide on a shared id, and reused as the DOM `data-tree-id`. */
function clientNodeId(group: ClientGroup): string {
  return `client:${group.clientId ?? "__none__"}`;
}
function projectNodeId(project: Project): string {
  return `project:${project.id}`;
}

function buildTreeNodes(groups: ClientGroup[]): TreeNode[] {
  const nodes: TreeNode[] = [];
  for (const group of groups) {
    const cid = clientNodeId(group);
    nodes.push({ id: cid, level: 1, parentId: null, expandable: false });
    for (const p of group.projects) {
      nodes.push({
        id: projectNodeId(p),
        level: 2,
        parentId: cid,
        expandable: true,
      });
    }
  }
  return nodes;
}

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
        // role="list" is redundant per ARIA but restores list semantics
        // that Safari/VoiceOver drop when `list-style: none` is set.
        // eslint-disable-next-line jsx-a11y/no-redundant-roles
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
  nodeId: string;
  active: boolean;
  expanded: boolean;
  onToggle: () => void;
  onItemFocus: (id: string) => void;
}

function ProjectNode({
  project,
  run,
  onDelete,
  nodeId,
  active,
  expanded,
  onToggle,
  onItemFocus,
}: ProjectNodeProps) {
  const cbEnabled = useColorblindEnabled();
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <li
      className="tree-project"
      // Disclosure tree (expand/collapse), not a selection tree — ARIA says
      // aria-selected is omitted on treeitems when selection is unsupported.
      // eslint-disable-next-line jsx-a11y/role-has-required-aria-props
      role="treeitem"
      aria-expanded={expanded}
      aria-label={project.name}
      data-tree-id={nodeId}
      tabIndex={active ? 0 : -1}
      // Only sync the roving id when this treeitem itself receives focus —
      // focusin bubbles, so without this guard focusing a descendant would
      // also fire the ancestor client's handler.
      onFocus={(e) => {
        if (e.target === e.currentTarget) onItemFocus(nodeId);
      }}
    >
      <div className="tree-project-row">
        <button
          type="button"
          className="tree-expand-btn"
          aria-label={
            expanded ? `Collapse ${project.name}` : `Expand ${project.name}`
          }
          tabIndex={-1}
          onClick={onToggle}
        >
          <Icon name={expanded ? "chevron-down" : "chevron-right"} size={12} />
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
  activeId: string;
  expandedProjects: Set<string>;
  onToggleProject: (nodeId: string) => void;
  onItemFocus: (id: string) => void;
}

function ClientGroupNode({
  group,
  projects,
  run,
  activeId,
  expandedProjects,
  onToggleProject,
  onItemFocus,
}: ClientGroupNodeProps) {
  const [draft, setDraft] = useState("");
  const nodeId = clientNodeId(group);

  const addProject = async () => {
    const name = draft.trim();
    if (!name) return;
    setDraft("");
    const color =
      PROJECT_COLORS[projects.projects.length % PROJECT_COLORS.length];
    await run(() => projects.create({ name, color, clientId: group.clientId }));
  };

  const deleteProject = useCallback(
    (id: string) => run(() => projects.remove(id)),
    [run, projects],
  );

  const groupLabel = group.client ? group.client.name : "No client";

  return (
    <li
      className="tree-client"
      // Disclosure tree (expand/collapse), not a selection tree — ARIA says
      // aria-selected is omitted on treeitems when selection is unsupported.
      // eslint-disable-next-line jsx-a11y/role-has-required-aria-props
      role="treeitem"
      aria-label={groupLabel}
      data-tree-id={nodeId}
      tabIndex={activeId === nodeId ? 0 : -1}
      // See ProjectNode: ignore focus bubbling up from descendant treeitems.
      onFocus={(e) => {
        if (e.target === e.currentTarget) onItemFocus(nodeId);
      }}
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
        {group.projects.map((p) => {
          const pid = projectNodeId(p);
          return (
            <ProjectNode
              key={p.id}
              project={p}
              run={run}
              onDelete={deleteProject}
              nodeId={pid}
              active={activeId === pid}
              expanded={expandedProjects.has(pid)}
              onToggle={() => onToggleProject(pid)}
              onItemFocus={onItemFocus}
            />
          );
        })}
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
  const nodes = useMemo(() => buildTreeNodes(groups), [groups]);

  const rootRef = useRef<HTMLUListElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [activeId, setActiveId] = useState<string>(() => nodes[0]?.id ?? "");

  // Keep the roving focus on a node that still exists after add/remove.
  useEffect(() => {
    if (nodes.length > 0 && !nodes.some((n) => n.id === activeId)) {
      setActiveId(nodes[0].id);
    }
  }, [nodes, activeId]);

  // Move DOM focus to a treeitem by id. Every treeitem is always
  // rendered (only its tabindex changes), so focusing imperatively is
  // reliable and doesn't depend on a re-render landing first.
  const focusItem = useCallback((id: string) => {
    const el = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>("[data-tree-id]") ?? [],
    ).find((e) => e.dataset.treeId === id);
    el?.focus();
  }, []);

  const onItemFocus = useCallback(
    (id: string) => setActiveId((cur) => (cur === id ? cur : id)),
    [],
  );

  const onToggleProject = useCallback((nodeId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    const target = e.target as HTMLElement;
    // Arrow/Home/End/Enter/Space drive tree navigation only when a
    // treeitem itself is focused; inside the add-project/-task inputs and
    // the action buttons they keep their normal behaviour.
    if (target.getAttribute("role") !== "treeitem") return;
    if (!TREE_NAV_KEYS.has(e.key)) return;
    e.preventDefault();
    // The focused treeitem is the source of truth — read it from the DOM
    // rather than the `activeId` state, which can lag a mouse/programmatic
    // focus that hasn't re-rendered yet.
    const currentId = target.dataset.treeId ?? activeId;
    const next = treeNavigate(nodes, { activeId: currentId, expanded }, e.key);
    setActiveId(next.activeId);
    setExpanded(next.expanded);
    if (next.activeId !== currentId) focusItem(next.activeId);
  };

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
      ref={rootRef}
      className="tree-root"
      role="tree"
      aria-label="Client, project, and task hierarchy"
      onKeyDown={onKeyDown}
    >
      {groups.map((group) => (
        <ClientGroupNode
          key={group.clientId ?? "__no_client__"}
          group={group}
          projects={projects}
          run={run}
          activeId={activeId}
          expandedProjects={expanded}
          onToggleProject={onToggleProject}
          onItemFocus={onItemFocus}
        />
      ))}
    </ul>
  );
}

export { buildGroups };

export type { ClientGroup };
