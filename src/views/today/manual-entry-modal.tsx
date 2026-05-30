import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Icon } from "../../lib/icon";
import type { SaveProjectInput } from "../../lib/ipc";
import type { Project } from "../../lib/types";

/** Swatches offered when creating a project inline. Mirrors the
 *  default-seed palette so new projects look at home next to them. */
const PROJECT_COLORS = [
  "#81b29a",
  "#f2cc8f",
  "#e07a5f",
  "#9a9bb0",
  "#c8b8e0",
  "#6d9dc5",
];

export interface ManualEntryDraft {
  id?: string;
  projectId: string | null;
  description: string;
  /** Local-datetime form value, e.g. "2026-05-26T09:30". */
  startedLocal: string;
  /** Local-datetime form value or empty string for "running". */
  endedLocal: string;
}

export interface ManualEntrySubmit {
  id?: string;
  projectId: string | null;
  description: string;
  /** RFC 3339 UTC timestamp. */
  startedAt: string;
  /** RFC 3339 UTC timestamp, or null for "running". */
  endedAt: string | null;
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
  onDelete?: (id: string) => Promise<void>;
  onClose: () => void;
}

const EMPTY_DRAFT: ManualEntryDraft = {
  projectId: null,
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
  onDelete,
  onClose,
}: Props) {
  const titleId = useId();
  const projectFieldId = useId();
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const [draft, setDraft] = useState<ManualEntryDraft>(initial ?? EMPTY_DRAFT);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inline create-project sub-form (#21 / #4).
  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectColor, setNewProjectColor] = useState(PROJECT_COLORS[0]);
  const [creatingProjectBusy, setCreatingProjectBusy] = useState(false);
  const [createProjectError, setCreateProjectError] = useState<string | null>(
    null,
  );
  const newProjectNameRef = useRef<HTMLInputElement | null>(null);

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
      setNewProjectColor(PROJECT_COLORS[0]);
      setCreateProjectError(null);
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

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = focusableElements(root);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!validation.ok) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        id: draft.id,
        projectId: draft.projectId,
        description: draft.description.trim(),
        startedAt: localToIso(draft.startedLocal),
        endedAt: draft.endedLocal ? localToIso(draft.endedLocal) : null,
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

  if (!open) return null;

  const title = mode === "edit" ? "Edit entry" : "New entry";

  return (
    <div
      ref={overlayRef}
      className="modal-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal entry-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleKeyDown}
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
            <div className="create-project" role="group" aria-label="New project">
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
                {PROJECT_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`swatch${c === newProjectColor ? " is-on" : ""}`}
                    style={{ background: c }}
                    role="radio"
                    aria-checked={c === newProjectColor}
                    aria-label={`Color ${c}`}
                    onClick={() => setNewProjectColor(c)}
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

          {/* TODO(#21 tags): wire chip input once tags / entry_tags IPC lands. */}

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
    return { ok: false, startError: "Start time is required.", overlapWarning: null };
  }
  // `<input type="datetime-local">` can only yield "" (caught above) or
  // a well-formed local timestamp. Date.parse(localToIso(...)) never
  // returns NaN for these inputs, so no Invalid-date branch is needed.
  const startTs = Date.parse(localToIso(draft.startedLocal));
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

function focusableElements(root: HTMLElement): HTMLElement[] {
  const selector =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => !el.hasAttribute("aria-hidden") && el.offsetParent !== null,
  );
}
