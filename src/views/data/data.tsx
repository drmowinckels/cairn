import { useMemo, useState } from "react";
import { Icon } from "../../lib/icon";
import { Empty } from "../../lib/components";
import { cbColor } from "../../lib/colorblind";
import { useColorblindEnabled } from "../../lib/use-colorblind";
import { useProjects } from "../../lib/use-projects";
import { useClients } from "../../lib/use-clients";
import { useTasks } from "../../lib/use-tasks";
import type { Client, Project } from "../../lib/types";
import { DataStorageActions } from "./data-storage";

const PROJECT_COLORS = [
  "#81b29a",
  "#f2cc8f",
  "#e07a5f",
  "#9a9bb0",
  "#c8b8e0",
  "#6d9dc5",
];

interface Density {
  density: "comfy" | "compact";
}

export function DataView({ density }: Density) {
  const projects = useProjects();
  const clients = useClients();
  const cbEnabled = useColorblindEnabled();

  const clientName = useMemo(() => {
    const map = new Map(clients.clients.map((c) => [c.id, c.name]));
    return (id: string | null) => (id ? (map.get(id) ?? "—") : "No client");
  }, [clients.clients]);

  return (
    <div className="view view-data" data-density={density}>
      <ProjectsSection
        projects={projects}
        clients={clients.clients}
        clientName={clientName}
        cbEnabled={cbEnabled}
      />
      <ClientsSection clients={clients} projects={projects.projects} />
      <TasksSection projects={projects.projects} />
      <section className="data-block" aria-label="Storage">
        <div className="sect-label">
          <span>Storage</span>
        </div>
        <DataStorageActions />
      </section>
    </div>
  );
}

// ── Projects ──────────────────────────────────────────────────────────

interface ProjectsSectionProps {
  projects: ReturnType<typeof useProjects>;
  clients: Client[];
  clientName: (id: string | null) => string;
  cbEnabled: boolean;
}

function ProjectsSection({
  projects,
  clients,
  clientName,
  cbEnabled,
}: ProjectsSectionProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <section className="data-block" aria-label="Projects">
      <div className="sect-label">
        <span>Projects</span>
        {!adding && (
          <button
            type="button"
            className="field-action"
            onClick={() => setAdding(true)}
          >
            <Icon name="plus" size={11} /> New project
          </button>
        )}
      </div>

      {adding && (
        <ProjectForm
          clients={clients}
          onCancel={() => setAdding(false)}
          onSubmit={async (input) => {
            await projects.create(input);
            setAdding(false);
          }}
        />
      )}

      {projects.projects.length === 0 && !adding ? (
        <Empty title="No projects yet" body="Add one to start tracking." tone="soft" />
      ) : (
        <ul className="data-list">
          {projects.projects.map((p) =>
            editing === p.id ? (
              <li key={p.id} className="data-row data-row--editing">
                <ProjectForm
                  initial={p}
                  clients={clients}
                  onCancel={() => setEditing(null)}
                  onSubmit={async (input) => {
                    await projects.update({ ...input, id: p.id });
                    setEditing(null);
                  }}
                />
              </li>
            ) : (
              <li key={p.id} className="data-row">
                <span
                  className="proj-dot"
                  style={{ background: cbColor(p.color, cbEnabled) }}
                />
                <span className="data-name">{p.name}</span>
                <span className="data-meta">{clientName(p.clientId)}</span>
                <span className="data-row-actions">
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => setEditing(p.id)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="link-btn link-btn--danger"
                    onClick={() => void projects.remove(p.id)}
                    aria-label={`Delete ${p.name}`}
                  >
                    Delete
                  </button>
                </span>
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}

interface ProjectFormProps {
  initial?: Project;
  clients: Client[];
  onCancel: () => void;
  onSubmit: (input: {
    name: string;
    color: string;
    clientId: string | null;
  }) => Promise<void>;
}

function ProjectForm({ initial, clients, onCancel, onSubmit }: ProjectFormProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [color, setColor] = useState(initial?.color ?? PROJECT_COLORS[0]);
  const [clientId, setClientId] = useState<string | null>(
    initial?.clientId ?? null,
  );
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await onSubmit({ name: name.trim(), color, clientId });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="data-form" role="group" aria-label={initial ? "Edit project" : "New project"}>
      <input
        className="field-input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder="Project name"
        aria-label="Project name"
        disabled={busy}
      />
      <div className="swatch-row" role="radiogroup" aria-label="Project color">
        {PROJECT_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={`swatch${c === color ? " is-on" : ""}`}
            style={{ background: c }}
            role="radio"
            aria-checked={c === color}
            aria-label={`Color ${c}`}
            onClick={() => setColor(c)}
            disabled={busy}
          />
        ))}
      </div>
      <select
        className="field-input"
        value={clientId ?? ""}
        onChange={(e) => setClientId(e.target.value === "" ? null : e.target.value)}
        aria-label="Client"
        disabled={busy}
      >
        <option value="">No client</option>
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <div className="data-form-actions">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={() => void submit()}
          disabled={busy || !name.trim()}
        >
          <Icon name="check" size={12} /> Save
        </button>
      </div>
    </div>
  );
}

// ── Clients ───────────────────────────────────────────────────────────

interface ClientsSectionProps {
  clients: ReturnType<typeof useClients>;
  projects: Project[];
}

function ClientsSection({ clients, projects }: ClientsSectionProps) {
  const [draft, setDraft] = useState("");
  const projectCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of projects) {
      if (p.clientId) counts.set(p.clientId, (counts.get(p.clientId) ?? 0) + 1);
    }
    return counts;
  }, [projects]);

  const add = async () => {
    const name = draft.trim();
    if (!name) return;
    setDraft("");
    await clients.create({ name });
  };

  return (
    <section className="data-block" aria-label="Clients">
      <div className="sect-label">
        <span>Clients</span>
      </div>
      {clients.clients.length === 0 ? (
        <Empty title="No clients" body="Group projects under a client (optional)." tone="soft" />
      ) : (
        <ul className="data-list">
          {clients.clients.map((c) => (
            <li key={c.id} className="data-row">
              <span className="data-name">{c.name}</span>
              <span className="data-meta">
                {projectCount.get(c.id) ?? 0} project
                {(projectCount.get(c.id) ?? 0) === 1 ? "" : "s"}
              </span>
              <span className="data-row-actions">
                <button
                  type="button"
                  className="link-btn link-btn--danger"
                  onClick={() => void clients.remove(c.id)}
                  aria-label={`Delete ${c.name}`}
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="data-add-row">
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
          placeholder="New client name"
          aria-label="New client name"
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
    </section>
  );
}

// ── Tasks ─────────────────────────────────────────────────────────────

function TasksSection({ projects }: { projects: Project[] }) {
  const [projectId, setProjectId] = useState<string | null>(
    projects[0]?.id ?? null,
  );
  const tasks = useTasks(projectId);
  const [draft, setDraft] = useState("");

  const add = async () => {
    const name = draft.trim();
    if (!name) return;
    setDraft("");
    await tasks.create(name);
  };

  return (
    <section className="data-block" aria-label="Tasks">
      <div className="sect-label">
        <span>Tasks</span>
      </div>
      <select
        className="field-input"
        value={projectId ?? ""}
        onChange={(e) => setProjectId(e.target.value === "" ? null : e.target.value)}
        aria-label="Project for tasks"
      >
        <option value="">Select a project…</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>

      {projectId && (
        <>
          {tasks.tasks.length === 0 ? (
            <Empty title="No tasks" body="Add tasks to break this project down." tone="soft" />
          ) : (
            <ul className="data-list">
              {tasks.tasks.map((t) => (
                <li key={t.id} className="data-row">
                  <span className="data-name">{t.name}</span>
                  <span className="data-row-actions">
                    <button
                      type="button"
                      className="link-btn link-btn--danger"
                      onClick={() => void tasks.remove(t.id)}
                      aria-label={`Delete ${t.name}`}
                    >
                      Delete
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="data-add-row">
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
              aria-label="New task name"
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
        </>
      )}
    </section>
  );
}
