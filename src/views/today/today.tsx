import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../lib/icon";
import { Empty, ErrorBanner, ProjectChip, Tag } from "../../lib/components";
import { cbColor } from "../../lib/colorblind";
import { useColorblindEnabled } from "../../lib/use-colorblind";
import { useRoundingPrefs } from "../../lib/use-rounding-prefs";
import { useAnnounce } from "../../lib/use-announce";
import { fmtClock, fmtClockFromIso, fmtHm } from "../../lib/time";
import { startEditError, validateStartEdit } from "../../lib/edit-start";
import { useTimer } from "../../lib/use-timer";
import { useSuggestion } from "../../lib/use-suggestion";
import { useProjects } from "../../lib/use-projects";
import { useToday } from "../../lib/use-today";
import { useUpcoming } from "../../lib/use-upcoming";
import { useCalendars } from "../../lib/use-calendars";
import { useDebouncedCallback } from "../../lib/use-debounced-callback";
import {
  entriesToSegments,
  legendFromSegments,
  startToPercent,
  type TimelineSegment,
} from "../../lib/timeline";
import {
  attributeEntryToRemoteTask,
  inTauri,
  listTasks,
  saveTask,
  type BackendEntry,
} from "../../lib/ipc";
import { useConnectors } from "../../lib/use-connectors";
import { useTaskMap } from "../../lib/use-tasks";
import {
  WORKING_HOURS_OFF,
  type WorkingHours,
} from "../../lib/use-working-hours";
import { useWorkingHoursReminder } from "../../lib/use-working-hours-reminder";
import {
  isSwitchCandidate,
  runningRefOf,
  TASK_SWITCH_OFF,
  type TaskSwitchPrefs,
} from "../../lib/task-switch";
import { useTaskSwitchPrompt } from "../../lib/use-task-switch-prompt";
import { TaskSwitchBanner } from "./task-switch-banner";
import type {
  Density,
  DetectionPrompts,
  LayoutVariant,
  Project,
  Task,
} from "../../lib/types";
import { RecentList, type RecentEntry } from "./recent-list";
import { SuggestWhy } from "./suggest-why";
import { UpcomingList, type UpcomingEvent } from "./upcoming-list";
import { WorkingHoursReminder } from "./working-hours-reminder";
import {
  isoToLocal,
  ManualEntryModal,
  type ManualEntryDraft,
  type ManualEntrySubmit,
} from "./manual-entry-modal";
import {
  canStop,
  missingRequiredFields,
  REQUIRED_FIELDS_OFF,
  type RequiredFieldsPrefs,
} from "../../lib/required-fields";
import type { PickedRemoteTask } from "./remote-task-picker";

/** Build the editor's connector-task link from a resolved task, or null when
 *  the task is local / absent (#110). */
export function remoteTaskOf(task: Task | undefined): PickedRemoteTask | null {
  if (!task?.connectorId || !task.remoteId) return null;
  return {
    connectorId: task.connectorId,
    remoteId: task.remoteId,
    label: task.name,
    url: task.remoteUrl ?? null,
    remoteProjectName: task.remoteProjectName ?? null,
  };
}

/** Seed a manual-entry edit draft from a saved entry, resolving its task id to
 *  the connector-task link so the chip shows on open (#110). */
export function draftFromEntry(
  entry: BackendEntry,
  tasksById: Record<string, Task>,
): ManualEntryDraft {
  return {
    id: entry.id,
    projectId: entry.projectId,
    taskId: entry.taskId,
    description: entry.description,
    startedLocal: isoToLocal(entry.startedAt),
    endedLocal: isoToLocal(entry.endedAt ?? ""),
    remoteTask: remoteTaskOf(
      entry.taskId ? tasksById[entry.taskId] : undefined,
    ),
  };
}

/** Attribute a just-saved entry to a picked connector task (#110). Returns a
 *  user-facing message if linking failed — the entry is already saved, so we
 *  don't throw (that would reopen the modal and a retry would duplicate the
 *  entry) — else null. A no-op returning null when nothing was picked. */
export async function linkRemoteTask(
  remoteTask: PickedRemoteTask | null | undefined,
  entryId: string,
  refresh: () => Promise<void>,
): Promise<string | null> {
  if (!remoteTask) return null;
  let error: string | null = null;
  try {
    await attributeEntryToRemoteTask({ entryId, ...remoteTask });
  } catch (e) {
    error = `Entry saved, but linking the task failed: ${
      e instanceof Error ? e.message : String(e)
    }`;
  }
  await refresh();
  return error;
}

interface Props {
  density: Density;
  layoutVariant: LayoutVariant;
  onOpenRule: (id: string) => void;
  detectionPrompts?: DetectionPrompts;
  announce?: boolean;
  /**
   * Increment this number from the popover header's `+` button to
   * open the manual-entry modal in create mode (#21).
   */
  addEntryRequest?: number;
  /** Working-hours reminder config (#99). Defaults to off. */
  workingHours?: WorkingHours;
  /** Task-switch prompt config (#105). Defaults to off. */
  taskSwitch?: TaskSwitchPrefs;
  /** Required-fields-on-stop config (#108). Defaults to off. */
  requiredFields?: RequiredFieldsPrefs;
}

export function TodayView({
  density,
  layoutVariant,
  onOpenRule,
  detectionPrompts = "subtle",
  announce = true,
  addEntryRequest = 0,
  workingHours = WORKING_HOURS_OFF,
  taskSwitch = TASK_SWITCH_OFF,
  requiredFields = REQUIRED_FIELDS_OFF,
}: Props) {
  const compact = density === "compact";
  const { projects, create: createProject } = useProjects();
  const { connectors } = useConnectors();
  const { byId: tasksById, refresh: refreshTasks } = useTaskMap();
  const today = useToday();
  const upcoming = useUpcoming(3);
  const calendars = useCalendars();
  const timer = useTimer({ onStopped: () => void today.refresh() });
  const { suggestion, confirm, dismiss } = useSuggestion({
    currentRunningRuleId: timer.running?.ruleId ?? null,
  });

  // #105 task-switch prompt: while tracking, watch for a *different* project's
  // rule becoming the top match and — after a dwell — offer to switch. When
  // enabled, the dwell-gated switch banner owns the "different project while
  // tracking" case, so the generic suggestion banner yields to it.
  const switchPrompt = useTaskSwitchPrompt({
    prefs: taskSwitch,
    running: timer.running,
  });
  const switchCandidate =
    taskSwitch.enabled &&
    isSwitchCandidate(suggestion, runningRefOf(timer.running));

  const runningProject = timer.running?.projectId ?? null;
  const runningTask = timer.running?.description ?? "";
  const runningSource = timer.running ? deriveSource(timer.running) : "manual";

  const totalSec = Math.floor(timer.elapsedMs / 1000);
  const hh = String(Math.floor(totalSec / 3600)).padStart(2, "0");
  const mm = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");

  const debouncedDesc = useDebouncedCallback((next: string) => {
    timer
      .update({ description: next })
      .catch((e) => console.error("update_entry failed", e));
  }, 400);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [idleProjectId, setIdleProjectId] = useState<string | null>(null);
  const [idlePickerOpen, setIdlePickerOpen] = useState(false);
  const [stopBlocked, setStopBlocked] = useState(false);
  const [editingStart, setEditingStart] = useState(false);
  const [startDraft, setStartDraft] = useState("");
  const [startError, setStartError] = useState<string | null>(null);

  // #: edit the running timer's start time ("forgot to start it"). Only the
  // start moves; project/description are untouched (update_entry is partial).
  const onCommitStart = useCallback(() => {
    const result = validateStartEdit(startDraft, Date.now());
    if (!result.ok) {
      setStartError(startEditError(result.reason));
      return;
    }
    setStartError(null);
    setEditingStart(false);
    timer
      .update({ startedAt: result.iso })
      .then(() => today.refresh())
      .catch((e) => console.error("update start failed", e));
  }, [startDraft, timer, today]);

  const onCancelStartEdit = useCallback(() => {
    setEditingStart(false);
    setStartError(null);
  }, []);

  const onPickProject = useCallback(
    (id: string) => {
      setPickerOpen(false);
      debouncedDesc.flush();
      timer
        .update({ projectId: id })
        .catch((e) => console.error("update_entry failed", e));
    },
    [debouncedDesc, timer],
  );

  // `running` is supplied by the call site, which only renders the Stop
  // button inside the `timer.running` branch — so there's no dead null-guard
  // here to leave uncovered.
  const onStop = useCallback(
    (running: BackendEntry) => {
      debouncedDesc.flush();
      const entry = {
        projectId: running.projectId,
        description: running.description,
      };
      if (!canStop(entry, requiredFields)) {
        setStopBlocked(true);
        return;
      }
      setStopBlocked(false);
      timer.stop().catch((e) => console.error("stop failed", e));
    },
    [debouncedDesc, timer, requiredFields],
  );

  const onQuickStart = (projectId: string) => {
    timer
      .start({ projectId, description: "" })
      .then(() => today.refresh())
      .catch((e) => console.error("start failed", e));
  };

  const onStartIdle = () => {
    timer
      .start({ projectId: idleProjectId, description: "" })
      .then(() => today.refresh())
      .catch((e) => console.error("start failed", e));
  };

  // #99 working-hours reminder: when idle during configured hours with no
  // timer running, offer to start tracking. Only offers — the user's tap
  // starts a blank timer they then fill in (suggestion ≠ auto-log).
  const reminder = useWorkingHoursReminder({ workingHours });

  const onReminderStart = useCallback(() => {
    reminder.acknowledge();
    timer
      .start({ projectId: null, description: "" })
      .then(() => today.refresh())
      .catch((e) => console.error("start failed", e));
  }, [reminder, timer, today]);

  const todayEntries = today.entries;
  const projectsById = useMemo(() => projectById(projects), [projects]);
  const cbEnabled = useColorblindEnabled();
  const { rounding } = useRoundingPrefs();
  const announceMsg = useAnnounce();
  const prevRunningIdRef = useRef<string | null>(timer.running?.id ?? null);

  useEffect(() => {
    const current = timer.running?.id ?? null;
    const previous = prevRunningIdRef.current;
    if (current && current !== previous) {
      const name = timer.running?.projectId
        ? (projectsById[timer.running.projectId]?.name ?? "no project")
        : "no project";
      announceMsg(`Timer started for ${name}`);
    } else if (!current && previous) {
      announceMsg("Timer stopped");
    }
    prevRunningIdRef.current = current;
  }, [timer.running, projectsById, announceMsg]);

  useEffect(() => {
    if (suggestion) {
      announceMsg(`Suggestion: ${suggestion.ruleName}`);
    }
  }, [suggestion, announceMsg]);

  useEffect(() => {
    if (!suggestion || detectionPrompts === "off") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Cascade contract (#27): if a modal is open, Esc closes it
      // first — the suggestion banner survives. Only dismiss the
      // suggestion when no modal is in the way. The modal's own
      // keydown handler runs on the modal element and is independent
      // of this document-level listener, so we check the DOM
      // directly rather than coordinating via a flag.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) {
        return;
      }
      dismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [suggestion, detectionPrompts, dismiss]);

  // ── manual-entry modal (#21) ────────────────────────────────────
  const [modalState, setModalState] = useState<
    | { open: false }
    | { open: true; mode: "create" | "edit"; draft: ManualEntryDraft }
  >({ open: false });
  // The entry saved but the remote-task link failed (#110). Surfaced as a
  // dismissible banner — the time entry persists, so we don't reopen the
  // modal (which would re-create it); the user can re-link from edit.
  const [attributeError, setAttributeError] = useState<string | null>(null);

  const openCreate = useCallback(() => {
    const now = new Date();
    const start = new Date(now.getTime() - 30 * 60_000);
    setModalState({
      open: true,
      mode: "create",
      draft: {
        projectId: null,
        taskId: null,
        description: "",
        startedLocal: isoToLocal(start.toISOString()),
        endedLocal: isoToLocal(now.toISOString()),
      },
    });
  }, []);

  const openEdit = useCallback(
    (entry: BackendEntry) => {
      setModalState({
        open: true,
        mode: "edit",
        draft: draftFromEntry(entry, tasksById),
      });
    },
    [tasksById],
  );

  const closeModal = useCallback(() => {
    setModalState({ open: false });
  }, []);

  useEffect(() => {
    if (addEntryRequest > 0) {
      openCreate();
    }
  }, [addEntryRequest, openCreate]);

  const handleSubmit = useCallback(
    async (payload: ManualEntrySubmit) => {
      setAttributeError(null);
      const entry = payload.id
        ? await today.update({
            id: payload.id,
            projectId: payload.projectId,
            taskId: payload.taskId,
            description: payload.description,
            startedAt: payload.startedAt,
            endedAt: payload.endedAt,
          })
        : await today.create({
            projectId: payload.projectId,
            taskId: payload.taskId,
            description: payload.description,
            startedAt: payload.startedAt,
            endedAt: payload.endedAt,
            source: "manual",
          });
      // Attribute to a connector task once the entry exists, so the intern +
      // link land on a real entry id (#110).
      // A successful attribution interns a task and changes the entry, so the
      // helper's refresh reloads both the entries and the task map (the latter
      // feeds the row chip). It only refreshes when a task was picked.
      const linkError = await linkRemoteTask(payload.remoteTask, entry.id, () =>
        Promise.all([today.refresh(), refreshTasks()]).then(() => undefined),
      );
      if (linkError) setAttributeError(linkError);
      void timer.refresh();
    },
    [today, timer, refreshTasks],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      await today.remove(id);
      void timer.refresh();
    },
    [today, timer],
  );

  const missingFields = useMemo(() => {
    if (!stopBlocked || !timer.running) {
      return { project: false, description: false };
    }
    return missingRequiredFields(
      {
        projectId: timer.running.projectId,
        description: timer.running.description,
      },
      requiredFields,
    );
  }, [stopBlocked, timer.running, requiredFields]);

  useEffect(() => {
    if (!stopBlocked || !timer.running) return;
    if (
      canStop(
        {
          projectId: timer.running.projectId,
          description: timer.running.description,
        },
        requiredFields,
      )
    ) {
      setStopBlocked(false);
    }
  }, [stopBlocked, timer.running, requiredFields]);

  const recentEntries = useMemo<RecentEntry[]>(() => {
    const closed = todayEntries.filter((e) => e.endedAt !== null);
    return [...closed]
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, 4)
      .map((e) => {
        const task = e.taskId ? tasksById[e.taskId] : undefined;
        return {
          id: e.id,
          projectId: e.projectId,
          description: e.description,
          startedAt: e.startedAt,
          endedAt: e.endedAt,
          source: e.source,
          // Only remote (connector) tasks get the chip; local task names
          // aren't surfaced on the row.
          remoteTaskLabel: task?.connectorId ? task.name : null,
        };
      });
  }, [todayEntries, tasksById]);

  const findEntryById = useCallback(
    (id: string): BackendEntry | undefined =>
      todayEntries.find((e) => e.id === id),
    [todayEntries],
  );

  const onEditRecent = useCallback(
    (id: string) => {
      // RecentList only renders ids from today.entries, so findEntryById
      // always returns a match.
      const entry = findEntryById(id);
      if (!entry) return;
      openEdit(entry);
    },
    [findEntryById, openEdit],
  );

  const upcomingEvents = useMemo<UpcomingEvent[]>(
    () =>
      upcoming.events.map((e) => ({
        uid: e.uid,
        summary: e.summary,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
      })),
    [upcoming.events],
  );

  const calendarsConnected = inTauri
    ? calendars.sources.some((s) => s.enabled)
    : true;

  const onUpcomingStart = useCallback(
    (event: UpcomingEvent) => {
      timer
        .start({ description: event.summary, source: "calendar" })
        .catch((e) => console.error("start failed", e));
    },
    [timer],
  );

  return (
    <div className="view view-today" data-density={density}>
      {detectionPrompts !== "off" && suggestion && !switchCandidate && (
        <section
          className={`suggest suggest--${detectionPrompts}`}
          aria-label="Auto-detected work"
          // A non-blocking inline notification, not a dialog: announce via
          // the live region (assertive for the heavier "modal" style,
          // polite otherwise) rather than claiming an `alertdialog` role it
          // doesn't honor (no focus trap / aria-modal / Escape).
          aria-live={
            announce
              ? detectionPrompts === "modal"
                ? "assertive"
                : "polite"
              : "off"
          }
        >
          <div className="suggest-head">
            <Icon name="sparkle" size={13} />
            <span>Detected</span>
            <button
              className="suggest-x"
              onClick={() => dismiss()}
              aria-label="Dismiss suggestion"
            >
              <Icon name="x" size={12} />
            </button>
          </div>
          <div className="suggest-body">
            {suggestion.project ? (
              <>
                Working on{" "}
                <ProjectChip project={projectsById[suggestion.project]} />
              </>
            ) : (
              <>Detected</>
            )}{" "}
            — <em>{suggestion.ruleName}</em>?
            {suggestion.tags.length > 0 && (
              <span className="suggest-tags">
                {suggestion.tags.map((t) => (
                  <Tag key={t}>{t}</Tag>
                ))}
              </span>
            )}
          </div>
          <div className="suggest-why">
            <SuggestWhy signals={suggestion.matchedSignals ?? []} />
            <button
              className="suggest-link"
              onClick={() => {
                const id = suggestion.ruleId;
                dismiss();
                onOpenRule(id);
              }}
            >
              view rule
            </button>
          </div>
          <div className="suggest-actions">
            <button className="btn btn--primary" onClick={() => void confirm()}>
              <Icon name="check" size={13} /> Confirm
            </button>
            <button
              className="btn btn--ghost"
              onClick={() => {
                // "Change…" = don't accept the rule's project; dismiss the
                // suggestion and open the idle project picker so the user
                // can choose what to start instead.
                dismiss();
                setIdlePickerOpen(true);
              }}
            >
              Change…
            </button>
          </div>
        </section>
      )}

      {detectionPrompts !== "off" && (
        <TaskSwitchBanner
          match={switchPrompt.active}
          projectsById={projectsById}
          style={detectionPrompts === "modal" ? "modal" : "subtle"}
          announce={announce}
          onConfirm={() => void switchPrompt.confirm()}
          onDismiss={switchPrompt.dismiss}
        />
      )}

      {/* Idle resolution now lives in the dedicated idle window (#93). */}

      {reminder.active && !timer.running && !suggestion && (
        <WorkingHoursReminder
          style={detectionPrompts === "modal" ? "modal" : "subtle"}
          announce={announce}
          onStart={onReminderStart}
          onDismiss={reminder.dismiss}
        />
      )}

      {timer.error && (
        <ErrorBanner
          message={`Couldn't reach the local timer service — ${timer.error}`}
          onRetry={() => timer.refresh()}
        />
      )}

      {attributeError && <ErrorBanner message={attributeError} />}

      <section
        className="now"
        aria-label="Current timer"
        aria-busy={timer.loading}
      >
        <div className="now-meta">
          <span className="now-label">
            {timer.loading
              ? "Connecting…"
              : timer.running
                ? "Now · running"
                : "Now · idle"}
          </span>
          {!timer.loading && timer.running && (
            <span
              className="now-source"
              title={
                runningSource === "rule"
                  ? "Started automatically by a rule"
                  : runningSource === "calendar"
                    ? "Started by a calendar event"
                    : "Started manually"
              }
            >
              <Icon
                name={
                  runningSource === "rule"
                    ? "sparkle"
                    : runningSource === "calendar"
                      ? "calendar"
                      : "edit"
                }
                size={11}
              />{" "}
              {runningSource}
            </span>
          )}
        </div>
        <div className="now-time" aria-live={announce ? "polite" : "off"}>
          <span className="t-hms">
            {hh}
            <span className="t-sep">:</span>
            {mm}
            <span className="t-sep">:</span>
            {ss}
          </span>
        </div>
        {!timer.loading && timer.running && !editingStart && (
          <button
            className="now-started"
            onClick={() => {
              setStartError(null);
              setStartDraft(isoToLocal(timer.running!.startedAt));
              setEditingStart(true);
            }}
            title="Edit start time"
            aria-label="Edit start time"
          >
            <Icon name="edit" size={10} /> started{" "}
            {fmtClockFromIso(timer.running.startedAt)}
          </button>
        )}
        {timer.running && editingStart && (
          <div className="now-start-edit">
            <input
              type="datetime-local"
              className="field-input"
              value={startDraft}
              onChange={(e) => setStartDraft(e.target.value)}
              max={isoToLocal(new Date().toISOString())}
              aria-label="Start time"
              aria-describedby={startError ? "start-edit-err" : undefined}
              aria-invalid={startError ? true : undefined}
            />
            <button
              className="btn btn--primary btn--sm"
              onClick={onCommitStart}
            >
              Set start
            </button>
            <button
              className="btn btn--ghost btn--sm"
              onClick={onCancelStartEdit}
            >
              Cancel
            </button>
            {startError && (
              <p id="start-edit-err" className="now-start-error" role="alert">
                {startError}
              </p>
            )}
          </div>
        )}
        {timer.running ? (
          <>
            <div className="now-task">
              <input
                key={timer.running.id}
                className="now-input"
                defaultValue={runningTask}
                aria-label="Task description"
                aria-describedby={
                  missingFields.description ? "stop-err-desc" : undefined
                }
                aria-invalid={missingFields.description || undefined}
                placeholder="What are you working on?"
                onChange={(e) => debouncedDesc(e.currentTarget.value)}
                onBlur={() => debouncedDesc.flush()}
              />
            </div>
            {stopBlocked && (
              <p
                className="now-stop-error"
                role="alert"
                aria-live="assertive"
                aria-atomic="true"
              >
                {missingFields.project && missingFields.description
                  ? "Add a project and description to stop."
                  : missingFields.project
                    ? "Choose a project to stop."
                    : "Add a description to stop."}
              </p>
            )}
            <p id="stop-err-desc" hidden={!missingFields.description}>
              A description is required before you can stop the timer.
            </p>
            <div className="now-row">
              <div className="now-chips">
                <ProjectPickerChip
                  projectId={runningProject}
                  projects={projects}
                  open={pickerOpen}
                  setOpen={setPickerOpen}
                  onPick={onPickProject}
                  cbEnabled={cbEnabled}
                  invalid={missingFields.project}
                />
              </div>
              <button
                className="btn btn--stop"
                aria-label="Stop timer"
                onClick={() => onStop(timer.running!)}
              >
                <Icon name="stop" size={12} /> Stop
              </button>
            </div>
          </>
        ) : (
          !timer.loading && (
            <div className="now-row">
              <div className="now-chips">
                <ProjectPickerChip
                  projectId={idleProjectId}
                  projects={projects}
                  open={idlePickerOpen}
                  setOpen={setIdlePickerOpen}
                  onPick={(id) => {
                    setIdleProjectId(id);
                    setIdlePickerOpen(false);
                  }}
                  cbEnabled={cbEnabled}
                />
              </div>
              <button
                className="btn btn--primary"
                aria-label="Start timer"
                onClick={onStartIdle}
              >
                <Icon name="play" size={12} /> Start
              </button>
            </div>
          )
        )}
      </section>

      {layoutVariant === "projects-first" && (
        <section className="quick" aria-label="Quick-start a project">
          <div className="sect-label">Quick start</div>
          {projects.length === 0 ? (
            <Empty
              title="No projects yet"
              body="Add a project from Settings to quick-start a timer."
              tone="soft"
            />
          ) : (
            <div className="quick-grid">
              {projects.slice(0, 4).map((p) => (
                <button
                  key={p.id}
                  className="quick-card"
                  onClick={() => onQuickStart(p.id)}
                >
                  <span
                    className="proj-dot"
                    style={{
                      background: cbColor(p.color, cbEnabled),
                      width: 8,
                      height: 8,
                    }}
                  />
                  <span className="quick-name">{p.name}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      <TimelineSection
        entries={todayEntries}
        projects={projects}
        announce={announce}
        cbEnabled={cbEnabled}
      />

      {!compact && layoutVariant !== "projects-first" && (
        <section className="recent" aria-label="Recent entries">
          <div className="sect-label">
            <span>Recent</span>
          </div>
          <RecentList
            entries={recentEntries}
            projectsById={projectsById}
            onEdit={onEditRecent}
            rounding={rounding}
          />
        </section>
      )}

      <section className="upcoming" aria-label="Upcoming calendar events">
        <div className="sect-label">
          <span>Up next</span>
        </div>
        <UpcomingList
          events={upcomingEvents}
          onStart={onUpcomingStart}
          calendarsConnected={calendarsConnected}
        />
      </section>

      {modalState.open && (
        <ManualEntryModal
          open
          mode={modalState.mode}
          initial={modalState.draft}
          projects={projects}
          runningRange={
            timer.running
              ? { startedAt: timer.running.startedAt, id: timer.running.id }
              : null
          }
          onSubmit={handleSubmit}
          onCreateProject={createProject}
          loadTasks={listTasks}
          onCreateTask={(projectId, name) => saveTask({ projectId, name })}
          connectors={connectors}
          onDelete={modalState.mode === "edit" ? handleDelete : undefined}
          onClose={closeModal}
        />
      )}
    </div>
  );
}

function deriveSource(entry: { source: string }): string {
  if (entry.source.startsWith("rule")) return "rule";
  if (entry.source === "calendar") return "calendar";
  return "manual";
}

function projectById(list: Project[]): Record<string, Project> {
  return Object.fromEntries(list.map((p) => [p.id, p]));
}

interface ProjectPickerChipProps {
  projectId: string | null;
  projects: Project[];
  open: boolean;
  setOpen: (v: boolean) => void;
  onPick: (id: string) => void;
  cbEnabled: boolean;
  invalid?: boolean;
}

// Stub project picker — clicking the chip opens a basic combobox over
// the live project list. The full ⌘K command palette ships in M6;
// this gives the user something better than a read-only label in the
// meantime.
function ProjectPickerChip({
  projectId,
  projects,
  open,
  setOpen,
  onPick,
  cbEnabled,
  invalid = false,
}: ProjectPickerChipProps) {
  const current = projectId
    ? projects.find((p) => p.id === projectId)
    : undefined;
  const ref = useRef<HTMLDivElement>(null);
  const hasProjects = projects.length > 0;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const node = ref.current;
      if (!node || !(e.target instanceof Node)) return;
      if (!node.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, setOpen]);

  return (
    <div className="now-picker" ref={ref}>
      {/* This button is a listbox trigger (aria-haspopup="listbox") and
          carries the required-fields validation state via aria-invalid so
          AT announces the blocked project picker; asserted in
          today.required-fields.test. */}
      {/* eslint-disable-next-line jsx-a11y/role-supports-aria-props */}
      <button
        type="button"
        className="proj-chip is-interactive"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-disabled={!hasProjects}
        aria-invalid={invalid || undefined}
        aria-label={
          current
            ? `Project: ${current.name}. Change project`
            : "Choose a project"
        }
        onClick={() => hasProjects && setOpen(!open)}
      >
        <span
          className="proj-dot"
          style={{
            background: current
              ? cbColor(current.color, cbEnabled)
              : "var(--ink-mute)",
          }}
        />
        <span className="proj-chip-name">{current?.name ?? "No project"}</span>
      </button>
      {open && hasProjects && (
        <ul className="now-picker-list" role="listbox">
          {projects.map((p) => (
            <li key={p.id} role="option" aria-selected={p.id === projectId}>
              <button
                type="button"
                className="now-picker-item"
                onClick={() => onPick(p.id)}
              >
                <span
                  className="proj-dot"
                  style={{ background: cbColor(p.color, cbEnabled) }}
                />
                {p.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface TimelineSectionProps {
  entries: BackendEntry[];
  projects: Project[];
  announce: boolean;
  cbEnabled: boolean;
}

function TimelineSection({
  entries,
  projects,
  announce,
  cbEnabled,
}: TimelineSectionProps) {
  const [nowMin, setNowMin] = useState(() => minutesNow());
  useEffect(() => {
    const id = window.setInterval(() => setNowMin(minutesNow()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const segments = useMemo(
    () => entriesToSegments(entries, nowMin),
    [entries, nowMin],
  );
  const legend = useMemo(
    () => legendFromSegments(segments, projects),
    [segments, projects],
  );

  const totalLoggedMin = useMemo(
    () =>
      segments.reduce((acc, s) => acc + Math.max(0, s.endMin - s.startMin), 0),
    [segments],
  );

  return (
    <section className="timeline" aria-label="Today's timeline">
      <div className="sect-label">
        <span>Today's path</span>
        <span className="sect-meta">
          {fmtHm(Math.round(totalLoggedMin))} logged
        </span>
      </div>
      {entries.length === 0 ? (
        <Empty
          title="No entries yet today"
          body="The timeline fills as you log time."
          tone="soft"
        />
      ) : (
        <>
          <DayTimeline
            segments={segments}
            projects={projects}
            nowMin={nowMin}
            announce={announce}
            cbEnabled={cbEnabled}
          />
          <ul className="legend">
            {legend.map((l) => (
              <li key={l.projectId} className="legend-item">
                <span
                  className="proj-dot"
                  style={{ background: cbColor(l.color, cbEnabled) }}
                />
                {l.name}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

interface DayTimelineProps {
  segments: TimelineSegment[];
  projects: Project[];
  nowMin: number;
  announce: boolean;
  cbEnabled: boolean;
}

function DayTimeline({
  segments,
  projects,
  nowMin,
  announce,
  cbEnabled,
}: DayTimelineProps) {
  const byId = useMemo(() => projectById(projects), [projects]);
  const nowPct = startToPercent(nowMin);

  return (
    <div
      className="dt-wrap"
      role="img"
      aria-label="Today's timeline from 08:00 to 19:00"
    >
      <div className="dt-track">
        {segments.map((s) => {
          const left = startToPercent(s.startMin);
          const right = startToPercent(s.endMin);
          const width = Math.max(0, right - left);
          const rawColor = s.projectId
            ? (byId[s.projectId]?.color ?? "var(--ink-mute)")
            : "var(--ink-mute)";
          const color = cbColor(rawColor, cbEnabled);
          const proj = s.projectId ? byId[s.projectId] : undefined;
          const label = proj
            ? `${proj.name} · ${s.description}`
            : s.description;
          return (
            <div
              key={s.id}
              className={`dt-seg${s.running ? " is-running" : ""}`}
              style={{
                left: `${left}%`,
                width: `${width}%`,
                background: color,
              }}
              title={label}
              aria-label={label}
            />
          );
        })}
        <div
          className="dt-now"
          style={{ left: `${nowPct}%` }}
          aria-label="Now"
          aria-live={announce ? "polite" : "off"}
        >
          <span className="dt-now-label">{fmtClock(Math.round(nowMin))}</span>
        </div>
      </div>
      <div className="dt-axis">
        {[8, 10, 12, 14, 16, 18].map((h) => (
          <span
            key={h}
            className="dt-tick"
            style={{ left: `${startToPercent(h * 60)}%` }}
          >
            {h}
          </span>
        ))}
      </div>
    </div>
  );
}

function minutesNow(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}
