import { useCallback, useMemo, useState } from "react";
import { Icon } from "../../lib/icon";
import { Empty } from "../../lib/components";
import { cbColor } from "../../lib/colorblind";
import { useColorblindEnabled } from "../../lib/use-colorblind";
import { useProjects } from "../../lib/use-projects";
import { useClients } from "../../lib/use-clients";
import { useTasks } from "../../lib/use-tasks";
import {
  budgetFraction,
  budgetLevel,
  formatHours,
  useBudget,
} from "../../lib/use-budget";
import type { Client, Project, ProjectBudgetStatus } from "../../lib/types";
import { DataStorageActions } from "./data-storage";

const PROJECT_COLORS = [
  "#81b29a",
  "#f2cc8f",
  "#e07a5f",
  "#9a9bb0",
  "#c8b8e0",
  "#6d9dc5",
];

/** Wraps a mutating action so a backend rejection surfaces an error
 *  instead of becoming an unhandled promise rejection. */
type Run = (fn: () => Promise<unknown>) => Promise<void>;

interface Props {
  density: "comfy" | "compact";
}

export function DataView({ density }: Props) {
  const projects = useProjects();
  const clients = useClients();
  const cbEnabled = useColorblindEnabled();
  const [error, setError] = useState<string | null>(null);

  const run = useCallback<Run>(async (fn) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const clientName = useMemo(() => {
    const map = new Map(clients.clients.map((c) => [c.id, c.name]));
    return (id: string | null) => (id ? (map.get(id) ?? "—") : "No client");
  }, [clients.clients]);

  // Deleting a client cascades `client_id = NULL` onto referencing
  // projects in the backend; refresh the (separate) projects hook so the
  // UI doesn't keep showing the dead association.
  const deleteClient = useCallback(
    (id: string) =>
      run(async () => {
        await clients.remove(id);
        await projects.refresh();
      }),
    [run, clients, projects],
  );

  return (
    <div className="view view-data" data-density={density}>
      {error && (
        <div className="privacy-banner privacy-banner--error" role="alert">
          <Icon name="x" size={13} />
          <span>{error}</span>
        </div>
      )}
      <ClientsSection
        clients={clients}
        projects={projects.projects}
        onDelete={deleteClient}
        run={run}
      />
      <ProjectsSection
        projects={projects}
        clients={clients.clients}
        clientName={clientName}
        cbEnabled={cbEnabled}
        run={run}
      />
      <TasksSection projects={projects.projects} run={run} />
      <section className="data-block" aria-label="Storage">
        <div className="sect-label">
          <span>Storage</span>
        </div>
        <DataStorageActions />
      </section>
    </div>
  );
}

// ── Inline delete confirmation ──────────────────────────────────────────

interface RowActionsProps {
  label: string;
  confirming: boolean;
  onEdit?: () => void;
  onAskDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}

function RowActions({
  label,
  confirming,
  onEdit,
  onAskDelete,
  onConfirmDelete,
  onCancelDelete,
}: RowActionsProps) {
  if (confirming) {
    return (
      <span className="data-row-actions">
        <span className="data-confirm-text">Delete?</span>
        <button
          type="button"
          className="link-btn link-btn--danger"
          onClick={onConfirmDelete}
        >
          Delete
        </button>
        <button type="button" className="link-btn" onClick={onCancelDelete}>
          Cancel
        </button>
      </span>
    );
  }
  return (
    <span className="data-row-actions">
      {onEdit && (
        <button type="button" className="link-btn" onClick={onEdit}>
          Edit
        </button>
      )}
      <button
        type="button"
        className="link-btn link-btn--danger"
        onClick={onAskDelete}
        aria-label={`Delete ${label}`}
      >
        Delete
      </button>
    </span>
  );
}

// ── Budget bar ───────────────────────────────────────────────────────

interface BudgetBarProps {
  status: ProjectBudgetStatus;
}

function BudgetBar({ status }: BudgetBarProps) {
  if (status.estimateHours === null) return null;
  const fraction = budgetFraction(status);
  const level = budgetLevel(status);
  const usedH = formatHours(status.usedSeconds);
  const estH = `${status.estimateHours}h`;
  const remainSecs = Math.max(0, status.estimateHours * 3600 - status.usedSeconds);
  const remainH = formatHours(remainSecs);
  const pct = Math.round(fraction * 100);

  return (
    <div
      className={`budget-bar budget-bar--${level}`}
      aria-label={`Budget: ${usedH} used of ${estH}, ${remainH} remaining`}
    >
      <div className="budget-bar-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="budget-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="budget-bar-text">
        {usedH} / {estH}
        {level === "over" ? (
          <span className="budget-bar-over"> over budget</span>
        ) : (
          <span className="budget-bar-remain"> ({remainH} left)</span>
        )}
      </span>
    </div>
  );
}

function ProjectBudgetRow({ projectId }: { projectId: string }) {
  const { status } = useBudget(projectId);
  if (!status || status.estimateHours === null) return null;
  return <BudgetBar status={status} />;
}

// ── Projects ──────────────────────────────────────────────────────────

interface ProjectsSectionProps {
  projects: ReturnType<typeof useProjects>;
  clients: Client[];
  clientName: (id: string | null) => string;
  cbEnabled: boolean;
  run: Run;
}

function ProjectsSection({
  projects,
  clients,
  clientName,
  cbEnabled,
  run,
}: ProjectsSectionProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  // Quick-add mirrors the client/task pattern: name only. The colour rotates
  // through the palette so successive projects differ at a glance; colour and
  // client are refined afterwards via Edit.
  const add = async () => {
    const name = draft.trim();
    if (!name) return;
    setDraft("");
    const color =
      PROJECT_COLORS[projects.projects.length % PROJECT_COLORS.length];
    await run(() => projects.create({ name, color, clientId: null }));
  };

  return (
    <section className="data-block" aria-label="Projects">
      <div className="sect-label">
        <span>Projects</span>
      </div>

      {projects.projects.length === 0 ? (
        <Empty
          title="No projects yet"
          body="Add one to start tracking."
          tone="soft"
        />
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
                    await run(async () => {
                      await projects.update({
                        ...input,
                        id: p.id,
                        estimateHours: input.estimateHours,
                      });
                      setEditing(null);
                    });
                  }}
                />
              </li>
            ) : (
              <li key={p.id} className="data-row data-row--project">
                <div className="data-row-main">
                  <span
                    className="proj-dot"
                    style={{ background: cbColor(p.color, cbEnabled) }}
                  />
                  <span className="data-name">{p.name}</span>
                  <span className="data-meta">{clientName(p.clientId)}</span>
                  <RowActions
                    label={p.name}
                    confirming={confirmId === p.id}
                    onEdit={() => setEditing(p.id)}
                    onAskDelete={() => setConfirmId(p.id)}
                    onConfirmDelete={() => {
                      setConfirmId(null);
                      void run(() => projects.remove(p.id));
                    }}
                    onCancelDelete={() => setConfirmId(null)}
                  />
                </div>
                <ProjectBudgetRow projectId={p.id} />
              </li>
            ),
          )}
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
          placeholder="New project name"
          aria-label="New project name"
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

// Edit-only form: name is quick-added inline, so this exists solely to refine
// an existing project's colour, client, and estimate.
interface ProjectFormProps {
  initial: Project;
  clients: Client[];
  onCancel: () => void;
  onSubmit: (input: {
    name: string;
    color: string;
    clientId: string | null;
    estimateHours: number | null;
  }) => Promise<void>;
}

function ProjectForm({
  initial,
  clients,
  onCancel,
  onSubmit,
}: ProjectFormProps) {
  const [name, setName] = useState(initial.name);
  const [color, setColor] = useState(initial.color);
  const [clientId, setClientId] = useState<string | null>(initial.clientId);
  const [estimateDraft, setEstimateDraft] = useState(
    initial.estimateHours !== null ? String(initial.estimateHours) : "",
  );
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) return;
    const parsed = estimateDraft.trim() === "" ? null : Number(estimateDraft);
    const estimateHours =
      parsed !== null && !Number.isNaN(parsed) && parsed > 0 ? parsed : null;
    setBusy(true);
    try {
      await onSubmit({ name: name.trim(), color, clientId, estimateHours });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="data-form" role="group" aria-label="Edit project">
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
        onChange={(e) =>
          setClientId(e.target.value === "" ? null : e.target.value)
        }
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
      <input
        className="field-input"
        type="number"
        min="0"
        step="0.5"
        value={estimateDraft}
        onChange={(e) => setEstimateDraft(e.target.value)}
        placeholder="Estimate (hours, optional)"
        aria-label="Estimate hours"
        disabled={busy}
      />
      <div className="data-form-actions">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={onCancel}
          disabled={busy}
        >
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
  onDelete: (id: string) => Promise<void>;
  run: Run;
}

function ClientsSection({
  clients,
  projects,
  onDelete,
  run,
}: ClientsSectionProps) {
  const [draft, setDraft] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
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
    await run(() => clients.create({ name }));
  };

  return (
    <section className="data-block" aria-label="Clients">
      <div className="sect-label">
        <span>Clients</span>
      </div>
      {clients.clients.length === 0 ? (
        <Empty
          title="No clients"
          body="Group projects under a client (optional)."
          tone="soft"
        />
      ) : (
        <ul className="data-list">
          {clients.clients.map((c) => {
            const count = projectCount.get(c.id) ?? 0;
            return (
              <li key={c.id} className="data-row">
                <span className="data-name">{c.name}</span>
                <span className="data-meta">
                  {count} project{count === 1 ? "" : "s"}
                </span>
                <RowActions
                  label={c.name}
                  confirming={confirmId === c.id}
                  onAskDelete={() => setConfirmId(c.id)}
                  onConfirmDelete={() => {
                    setConfirmId(null);
                    void onDelete(c.id);
                  }}
                  onCancelDelete={() => setConfirmId(null)}
                />
              </li>
            );
          })}
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

function TasksSection({ projects, run }: { projects: Project[]; run: Run }) {
  const [projectId, setProjectId] = useState<string | null>(
    projects[0]?.id ?? null,
  );
  const tasks = useTasks(projectId);
  const [draft, setDraft] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const add = async () => {
    const name = draft.trim();
    if (!name) return;
    setDraft("");
    await run(() => tasks.create(name));
  };

  return (
    <section className="data-block" aria-label="Tasks">
      <div className="sect-label">
        <span>Tasks</span>
      </div>
      <select
        className="field-input"
        value={projectId ?? ""}
        onChange={(e) =>
          setProjectId(e.target.value === "" ? null : e.target.value)
        }
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
            <Empty
              title="No tasks"
              body="Add tasks to break this project down."
              tone="soft"
            />
          ) : (
            <ul className="data-list">
              {tasks.tasks.map((t) => (
                <li key={t.id} className="data-row">
                  <span className="data-name">{t.name}</span>
                  <RowActions
                    label={t.name}
                    confirming={confirmId === t.id}
                    onAskDelete={() => setConfirmId(t.id)}
                    onConfirmDelete={() => {
                      setConfirmId(null);
                      void run(() => tasks.remove(t.id));
                    }}
                    onCancelDelete={() => setConfirmId(null)}
                  />
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
