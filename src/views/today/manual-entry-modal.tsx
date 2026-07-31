import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Icon } from "../../lib/icon";
import { useFocusTrap } from "../../lib/use-focus-trap";
import { isSafeExternalUrl } from "../../lib/url";
import type { Connector, SaveProjectInput } from "../../lib/ipc";
import type { Project, Task } from "../../lib/types";
import { RemoteTaskPicker, type PickedRemoteTask } from "./remote-task-picker";

/** Swatches offered when creating a project inline. Mirrors the
 *  default-seed palette so new projects look at home next to them. */
// Named so the color radios announce a human word ("Sage") to screen
// readers instead of an unpronounceable hex string ("#81b29a").
const PROJECT_COLORS: ReadonlyArray<{ hex: string; name: string }> = [
  { hex: "#81b29a", name: "Sage" },
  { hex: "#f2cc8f", name: "Sand" },
  { hex: "#e07a5f", name: "Clay" },
  { hex: "#9a9bb0", name: "Slate" },
  { hex: "#c8b8e0", name: "Lilac" },
  { hex: "#6d9dc5", name: "Sky" },
];
const DEFAULT_PROJECT_COLOR = PROJECT_COLORS[0].hex;

export interface ManualEntryDraft {
  id?: string;
  projectId: string | null;
  taskId: string | null;
  description: string;
  /** Local-datetime form value, e.g. "2026-05-26T09:30". */
  startedLocal: string;
  /** Local-datetime form value or empty string for "running". */
  endedLocal: string;
  /** Pre-existing connector-task link (#110), seeded on edit so the chip shows
   *  the current attribution. `null`/absent ⇒ not linked. */
  remoteTask?: PickedRemoteTask | null;
}

export interface ManualEntrySubmit {
  id?: string;
  projectId: string | null;
  taskId: string | null;
  description: string;
  /** RFC 3339 UTC timestamp. */
  startedAt: string;
  /** RFC 3339 UTC timestamp, or null for "running". */
  endedAt: string | null;
  /** A connector task to attribute the entry to after it is created/updated
   *  (#110). `null` ⇒ no remote attribution this submit. */
  remoteTask?: PickedRemoteTask | null;
}

interface Props {
  open: boolean;
  mode: "create" | "edit";
  initial: ManualEntryDraft;
  projects: Project[];
  /**
   * Optional currently-running entry interval used to flag overlap.
   * Callers pass `null` when no timer is running.
   */
  runningRange: { startedAt: string; id: string } | null;
  onSubmit: (payload: ManualEntrySubmit) => Promise<void>;
  /**
   * Create a project inline from the Project field. When provided, a
   * "New project" affordance appears beside the picker; the freshly
   * created project is selected on the draft. Omitted in contexts with
   * no live project store (the create flow is simply hidden).
   */
  onCreateProject?: (input: SaveProjectInput) => Promise<Project>;
  /**
   * Load the tasks for a project (the entry's optional sub-label).
   * When provided alongside a selected project, a Task picker appears.
   * Omitted in contexts with no task store (the picker stays hidden).
   */
  loadTasks?: (projectId: string) => Promise<Task[]>;
  /** Create a task under a project inline from the Task picker. */
  onCreateTask?: (projectId: string, name: string) => Promise<Task>;
  /**
   * Enabled PM connectors (#110). When provided and non-empty, a "Link a
   * connector task" affordance lets the user attribute the entry to a remote
   * task. Omitted/empty in contexts with no connector store.
   */
  connectors?: Connector[];
  onDelete?: (id: string) => Promise<void>;
  /** When editing an entry already billed on an invoice (#287), its invoice
   *  number. Shows a non-blocking notice; editing stays allowed — the invoice
   *  is a frozen snapshot, so changes here won't alter it. */
  billedInvoiceNumber?: string | null;
  onClose: () => void;
}

/** Whether two connector-task links refer to the same remote task (#110) —
 *  used to skip a needless re-attribution on an untouched edit-save. Both
 *  `null` counts as same. */
export function sameRemoteLink(
  a: PickedRemoteTask | null,
  b: PickedRemoteTask | null,
): boolean {
  return a?.connectorId === b?.connectorId && a?.remoteId === b?.remoteId;
}

const EMPTY_DRAFT: ManualEntryDraft = {
  projectId: null,
  taskId: null,
  description: "",
  startedLocal: "",
  endedLocal: "",
};

export function ManualEntryModal({
  open,
  mode,
  initial,
  projects,
  runningRange,
  onSubmit,
  onCreateProject,
  loadTasks,
  onCreateTask,
  connectors,
  onDelete,
  billedInvoiceNumber,
  onClose,
}: Props) {
  const titleId = useId();
  const projectFieldId = useId();
  const taskFieldId = useId();
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const trap = useFocusTrap(onClose);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const [draft, setDraft] = useState<ManualEntryDraft>(initial ?? EMPTY_DRAFT);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inline create-project sub-form (#21 / #4).
  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectColor, setNewProjectColor] = useState(DEFAULT_PROJECT_COLOR);
  const [creatingProjectBusy, setCreatingProjectBusy] = useState(false);
  const [createProjectError, setCreateProjectError] = useState<string | null>(
    null,
  );
  const newProjectNameRef = useRef<HTMLInputElement | null>(null);

  // Task picker (#21). Tasks are project-scoped, so the list reloads
  // whenever the selected project changes.
  const [tasks, setTasks] = useState<Task[]>([]);
  const [creatingTask, setCreatingTask] = useState(false);
  const [newTaskName, setNewTaskName] = useState("");
  const [creatingTaskBusy, setCreatingTaskBusy] = useState(false);
  const [createTaskError, setCreateTaskError] = useState<string | null>(null);
  const newTaskNameRef = useRef<HTMLInputElement | null>(null);

  // Remote-task attribution (#110). A picked connector task is linked on
  // submit; selecting one supersedes the local task (both set entries.task_id).
  const [remoteTask, setRemoteTask] = useState<PickedRemoteTask | null>(null);
  const [showRemotePicker, setShowRemotePicker] = useState(false);

  useEffect(() => {
    if (!loadTasks || !draft.projectId) {
      setTasks([]);
      return;
    }
    let cancelled = false;
    void loadTasks(draft.projectId)
      .then((t) => {
        if (!cancelled) setTasks(t);
      })
      .catch(() => {
        if (!cancelled) setTasks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [loadTasks, draft.projectId]);

  // Only seed draft + capture opener on the `open` false→true transition.
  // If we depended on `initial` here, every parent re-render (timer
  // tick, suggestion arrival) would recreate `initial` and blow away
  // the user's in-progress edits.
  useEffect(() => {
    if (open) {
      openerRef.current =
        (document.activeElement as HTMLElement | null) ?? null;
      setDraft(initial);
      setConfirmDelete(false);
      setError(null);
      setCreatingProject(false);
      setNewProjectName("");
      setNewProjectColor(DEFAULT_PROJECT_COLOR);
      setCreateProjectError(null);
      setCreatingTask(false);
      setCreatingTaskBusy(false);
      setNewTaskName("");
      setCreateTaskError(null);
      setRemoteTask(initial.remoteTask ?? null);
      setShowRemotePicker(false);
      // Drop the previous project's tasks so a reopen for a different
      // project can't flash a stale list before loadTasks resolves.
      setTasks([]);
      const id = window.requestAnimationFrame(() => {
        firstFieldRef.current?.focus();
      });
      return () => window.cancelAnimationFrame(id);
    }
    const opener = openerRef.current;
    if (opener && typeof opener.focus === "function") {
      opener.focus();
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: see comment above.
  }, [open]);

  const validation = useMemo(
    () => validateDraft(draft, runningRange),
    [draft, runningRange],
  );

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!validation.ok) return;
    setSubmitting(true);
    setError(null);
    // Only (re)attribute when the connector-task link actually changed this
    // session. An unchanged seeded link is already on `draft.taskId`, so
    // re-nulling + re-linking it would be wasteful and — because the null and
    // the re-link are separate transactions — would PERMANENTLY drop the link
    // if the connector is now disabled (the null commits, the re-link fails).
    // #110
    const linkChanged = !sameRemoteLink(remoteTask, initial.remoteTask ?? null);
    try {
      await onSubmit({
        id: draft.id,
        projectId: draft.projectId,
        // When the link changed we null the task id and let attribution (or an
        // unlink) set it. Otherwise keep the current id — a non-null value is a
        // valid local OR unchanged remote task; clearing the project already
        // nulls a local selection (see the Project onChange).
        taskId: linkChanged ? null : draft.taskId,
        description: draft.description.trim(),
        startedAt: localToIso(draft.startedLocal),
        endedAt: draft.endedLocal ? localToIso(draft.endedLocal) : null,
        remoteTask: linkChanged ? remoteTask : null,
      });
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!draft.id || !onDelete) return;
    setSubmitting(true);
    setError(null);
    try {
      await onDelete(draft.id);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const openCreateProject = () => {
    setCreatingProject(true);
    setCreateProjectError(null);
    window.requestAnimationFrame(() => newProjectNameRef.current?.focus());
  };

  const cancelCreateProject = () => {
    setCreatingProject(false);
    setNewProjectName("");
    setCreateProjectError(null);
  };

  const handleCreateProject = async () => {
    if (!onCreateProject) return;
    const name = newProjectName.trim();
    if (!name) {
      setCreateProjectError("Give the project a name.");
      newProjectNameRef.current?.focus();
      return;
    }
    setCreatingProjectBusy(true);
    setCreateProjectError(null);
    try {
      const project = await onCreateProject({ name, color: newProjectColor });
      setDraft((d) => ({ ...d, projectId: project.id }));
      setCreatingProject(false);
      setNewProjectName("");
    } catch (err) {
      setCreateProjectError(String(err));
    } finally {
      setCreatingProjectBusy(false);
    }
  };

  const openCreateTask = () => {
    setCreatingTask(true);
    setCreateTaskError(null);
    window.requestAnimationFrame(() => newTaskNameRef.current?.focus());
  };

  const cancelCreateTask = () => {
    setCreatingTask(false);
    setNewTaskName("");
    setCreateTaskError(null);
  };

  const handleCreateTask = async () => {
    if (!onCreateTask || !draft.projectId) return;
    const name = newTaskName.trim();
    if (!name) {
      setCreateTaskError("Give the task a name.");
      newTaskNameRef.current?.focus();
      return;
    }
    setCreatingTaskBusy(true);
    setCreateTaskError(null);
    try {
      const task = await onCreateTask(draft.projectId, name);
      setTasks((prev) => [...prev.filter((t) => t.id !== task.id), task]);
      setDraft((d) => ({ ...d, taskId: task.id }));
      setCreatingTask(false);
      setNewTaskName("");
    } catch (err) {
      setCreateTaskError(String(err));
    } finally {
      setCreatingTaskBusy(false);
    }
  };

  if (!open) return null;

  const title = mode === "edit" ? "Edit entry" : "New entry";
  const showTaskPicker = Boolean(loadTasks && draft.projectId);
  // A linked remote task supersedes the local one, so hide the local picker
  // while one is linked.
  const showLocalTask = showTaskPicker && !remoteTask;
  const enabledConnectors = (connectors ?? []).filter((c) => c.enabled);

  return (
    <div
      ref={overlayRef}
      className="modal-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      {/* Focus-trapped modal: onKeyDown handles Escape/Tab. The dialog
          role is non-interactive but key handling here is the standard
          modal pattern, not a clickable control. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={trap.ref}
        className="modal entry-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={trap.onKeyDown}
      >
        <header className="modal-head">
          <h2 id={titleId} className="modal-title">
            {title}
          </h2>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close"
          >
            <Icon name="x" size={14} />
          </button>
        </header>

        {billedInvoiceNumber && (
          <p className="modal-billed-note" role="note">
            <Icon name="info" size={13} />
            <span>
              On invoice {billedInvoiceNumber}. Editing this entry won&apos;t
              change that invoice.
            </span>
          </p>
        )}

        <form className="modal-body" onSubmit={handleSubmit}>
          <label className="field">
            <span className="field-label">Description</span>
            <input
              ref={firstFieldRef}
              type="text"
              className="field-input"
              value={draft.description}
              onChange={(e) =>
                setDraft((d) => ({ ...d, description: e.target.value }))
              }
              placeholder="What were you working on?"
            />
          </label>

          <div className="field">
            <div className="field-label-row">
              <label className="field-label" htmlFor={projectFieldId}>
                Project
              </label>
              {onCreateProject && !creatingProject && (
                <button
                  type="button"
                  className="field-action"
                  onClick={openCreateProject}
                >
                  <Icon name="plus" size={11} /> New project
                </button>
              )}
            </div>
            <select
              id={projectFieldId}
              className="field-input"
              value={draft.projectId ?? ""}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  projectId: e.target.value === "" ? null : e.target.value,
                  // Changing project invalidates the task selection.
                  taskId: null,
                }))
              }
            >
              <option value="">No project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {onCreateProject && creatingProject && (
            <div
              className="create-project"
              role="group"
              aria-label="New project"
            >
              <input
                ref={newProjectNameRef}
                type="text"
                className="field-input"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleCreateProject();
                  }
                }}
                placeholder="New project name"
                aria-label="New project name"
                disabled={creatingProjectBusy}
              />
              <div
                className="swatch-row"
                role="radiogroup"
                aria-label="Project color"
              >
                {PROJECT_COLORS.map(({ hex, name }) => (
                  <button
                    key={hex}
                    type="button"
                    className={`swatch${hex === newProjectColor ? " is-on" : ""}`}
                    style={{ background: hex }}
                    role="radio"
                    aria-checked={hex === newProjectColor}
                    aria-label={name}
                    onClick={() => setNewProjectColor(hex)}
                    disabled={creatingProjectBusy}
                  />
                ))}
              </div>
              {createProjectError && (
                <p className="field-error" role="alert">
                  {createProjectError}
                </p>
              )}
              <div className="create-project-actions">
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={cancelCreateProject}
                  disabled={creatingProjectBusy}
                  aria-label="Cancel new project"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void handleCreateProject()}
                  disabled={creatingProjectBusy || !newProjectName.trim()}
                >
                  <Icon name="check" size={12} /> Add project
                </button>
              </div>
            </div>
          )}

          {showLocalTask && (
            <div className="field">
              <div className="field-label-row">
                <label className="field-label" htmlFor={taskFieldId}>
                  Task
                </label>
                {onCreateTask && !creatingTask && (
                  <button
                    type="button"
                    className="field-action"
                    onClick={openCreateTask}
                  >
                    <Icon name="plus" size={11} /> New task
                  </button>
                )}
              </div>
              <select
                id={taskFieldId}
                className="field-input"
                value={draft.taskId ?? ""}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    taskId: e.target.value === "" ? null : e.target.value,
                  }))
                }
              >
                <option value="">No task</option>
                {tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {showLocalTask && onCreateTask && creatingTask && (
            <div className="create-project" role="group" aria-label="New task">
              <input
                ref={newTaskNameRef}
                type="text"
                className="field-input"
                value={newTaskName}
                onChange={(e) => setNewTaskName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleCreateTask();
                  }
                }}
                placeholder="New task name"
                aria-label="New task name"
                disabled={creatingTaskBusy}
              />
              {createTaskError && (
                <p className="field-error" role="alert">
                  {createTaskError}
                </p>
              )}
              <div className="create-project-actions">
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={cancelCreateTask}
                  disabled={creatingTaskBusy}
                  aria-label="Cancel new task"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void handleCreateTask()}
                  disabled={creatingTaskBusy || !newTaskName.trim()}
                >
                  <Icon name="check" size={12} /> Add task
                </button>
              </div>
            </div>
          )}

          {enabledConnectors.length > 0 && (
            <div className="field">
              {remoteTask ? (
                <div className="remote-link" data-testid="remote-link">
                  <Icon name="globe" size={13} />
                  <span className="remote-link-label">{remoteTask.label}</span>
                  {isSafeExternalUrl(remoteTask.url) && (
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => void openUrl(remoteTask.url as string)}
                    >
                      Open
                    </button>
                  )}
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => setRemoteTask(null)}
                    aria-label="Unlink task"
                  >
                    Unlink
                  </button>
                </div>
              ) : showRemotePicker ? (
                <RemoteTaskPicker
                  connectors={enabledConnectors}
                  onPick={(picked) => {
                    setRemoteTask(picked);
                    setShowRemotePicker(false);
                    setDraft((d) => ({ ...d, taskId: null }));
                  }}
                  onCancel={() => setShowRemotePicker(false)}
                />
              ) : (
                <button
                  type="button"
                  className="field-action"
                  onClick={() => setShowRemotePicker(true)}
                >
                  <Icon name="globe" size={11} /> Link a connector task
                </button>
              )}
            </div>
          )}

          <div className="field-row">
            <label className="field">
              <span className="field-label">Start</span>
              <input
                type="datetime-local"
                className="field-input"
                value={draft.startedLocal}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, startedLocal: e.target.value }))
                }
                required
              />
            </label>
            <label className="field">
              <span className="field-label">
                End <span className="field-hint">(blank = running)</span>
              </span>
              <input
                type="datetime-local"
                className="field-input"
                value={draft.endedLocal}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, endedLocal: e.target.value }))
                }
              />
            </label>
          </div>

          {validation.startError && (
            <p className="field-error" role="alert">
              {validation.startError}
            </p>
          )}

          {validation.overlapWarning && (
            <p className="field-warning" role="status">
              {validation.overlapWarning}
            </p>
          )}

          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}

          <footer className="modal-foot">
            {mode === "edit" && onDelete && draft.id ? (
              confirmDelete ? (
                <div className="confirm-row">
                  <span className="confirm-text">Delete this entry?</span>
                  <button
                    type="button"
                    className="btn btn--danger"
                    onClick={handleDelete}
                    disabled={submitting}
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => setConfirmDelete(false)}
                    disabled={submitting}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="btn btn--ghost btn--danger-ghost"
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete
                </button>
              )
            ) : (
              <span />
            )}
            <span className="spacer" />
            <button
              type="button"
              className="btn btn--ghost"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={!validation.ok || submitting}
            >
              <Icon name="check" size={13} /> Save
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

interface Validation {
  ok: boolean;
  startError: string | null;
  overlapWarning: string | null;
}

export function validateDraft(
  draft: ManualEntryDraft,
  runningRange: { startedAt: string; id: string } | null,
): Validation {
  if (!draft.startedLocal) {
    return {
      ok: false,
      startError: "Start time is required.",
      overlapWarning: null,
    };
  }
  // `<input type="datetime-local">` normally yields "" (caught above) or
  // a well-formed local timestamp. Guard the unparseable case anyway:
  // `localToIso` returns "" on an invalid value, so a non-empty-but-bad
  // start would otherwise pass validation as NaN and forward "" to the
  // backend. Reject it as a missing start instead.
  const startTs = Date.parse(localToIso(draft.startedLocal));
  if (Number.isNaN(startTs)) {
    return {
      ok: false,
      startError: "Start time is required.",
      overlapWarning: null,
    };
  }
  if (draft.endedLocal) {
    const endTs = Date.parse(localToIso(draft.endedLocal));
    if (endTs <= startTs) {
      return {
        ok: false,
        startError: "End must be after start.",
        overlapWarning: null,
      };
    }
  }
  let overlapWarning: string | null = null;
  // Open-ended drafts replace the running timer in create_entry, so
  // overlap with it is by design — don't warn. `runningRange.startedAt`
  // is an RFC3339 string from the backend and never parses to NaN.
  if (draft.endedLocal && runningRange && runningRange.id !== draft.id) {
    const runningStart = Date.parse(runningRange.startedAt);
    const endTs = Date.parse(localToIso(draft.endedLocal));
    const runningEnd = Date.now();
    // Two ranges [startTs, endTs] and [runningStart, runningEnd]
    // overlap iff startTs < runningEnd && endTs > runningStart.
    const overlap = startTs < runningEnd && endTs > runningStart;
    if (overlap) {
      overlapWarning =
        "This entry overlaps with the currently-running timer — that's allowed but will be saved as-is.";
    }
  }
  return { ok: true, startError: null, overlapWarning };
}

/**
 * Convert an HTML `datetime-local` value (no zone, local clock) into
 * an RFC 3339 UTC ISO string. The browser interprets the value in
 * the user's local zone, which is exactly what we want — the user
 * typed "09:30" expecting their wall clock, and SQLite stores UTC.
 */
export function localToIso(local: string): string {
  if (!local) return "";
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString();
}

/**
 * Inverse of `localToIso` — render a UTC ISO timestamp as the
 * `datetime-local`-shaped string ("YYYY-MM-DDTHH:MM") in the user's
 * local zone. Used to pre-fill the form in edit mode.
 */
export function isoToLocal(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
