import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../lib/icon";
import { isoLocalDate } from "../../lib/report-math";
import { Empty, ErrorBanner, ProjectChip, Tag } from "../../lib/components";
import { cbColor } from "../../lib/colorblind";
import { useColorblindEnabled } from "../../lib/use-colorblind";
import { useRoundingPrefs } from "../../lib/use-rounding-prefs";
import { useAnnounce } from "../../lib/use-announce";
import { fmtClock, fmtClockFromIso, fmtHm } from "../../lib/time";
import { startEditError, validateStartEdit } from "../../lib/edit-start";
import { useTimer } from "../../lib/use-timer";
import { useSuggestion, type Suggestion } from "../../lib/use-suggestion";
import { useRules, defaultOpForSignal } from "../../lib/use-rules";
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
  updateEntry,
  type BackendEntry,
} from "../../lib/ipc";
import {
  bestLearnedRuleCandidate,
  buildReviewInbox,
  computeFocusInsights,
  DISMISSED_LEARNING_KEY,
  loadSuggestionFeedback,
  plannedVsActualMinutes,
  recordSuggestionFeedback,
  saveSuggestionFeedback,
  type LearnedRuleCandidate,
  type SuggestionFeedbackEvent,
  type SuggestionOutcome,
} from "../../lib/review-insights";
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
  // Day navigation (#editing-past-days): the view defaults to today but can
  // step back to view + edit a past day's entries. Live affordances (timer,
  // quick-start, suggestions, Up Next) only make sense for today and are
  // hidden when viewing the past.
  const todayIso = isoLocalDate(new Date());
  const [viewDate, setViewDate] = useState(todayIso);
  const isToday = viewDate === todayIso;
  const today = useToday({ date: viewDate });
  const stepDay = (delta: number) => {
    const [y, m, d] = viewDate.split("-").map(Number);
    setViewDate(isoLocalDate(new Date(y!, m! - 1, d! + delta)));
  };
  const dateLabel = isToday
    ? "Today"
    : new Date(viewDate + "T00:00:00").toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
  const upcoming = useUpcoming(3);
  const calendars = useCalendars();
  const timer = useTimer({ onStopped: () => void today.refresh() });
  const { suggestion, confirm, dismiss } = useSuggestion({
    currentRunningRuleId: timer.running?.ruleId ?? null,
  });

  // #191 suggestion feedback loop: every confirm/dismiss/change is recorded
  // locally so we can (a) propose an explicit "learned" rule once a pattern
  // repeats and (b) surface trust/quality analytics. Feedback is the only new
  // state persisted — window titles are never stored (privacy contract).
  const rules = useRules();
  const [feedbackEvents, setFeedbackEvents] = useState<
    SuggestionFeedbackEvent[]
  >(() => loadSuggestionFeedback());
  const [pendingChangedSuggestion, setPendingChangedSuggestion] =
    useState<Suggestion | null>(null);
  const [reviewProjectId, setReviewProjectId] = useState<string | null>(null);
  const [learningBusy, setLearningBusy] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [learnError, setLearnError] = useState<string | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [dismissedLearningSignature, setDismissedLearningSignature] = useState<
    string | null
  >(() => window.localStorage.getItem(DISMISSED_LEARNING_KEY));

  const commitFeedback = useCallback(
    (
      match: Suggestion,
      outcome: SuggestionOutcome,
      selectedProjectId: string | null = null,
    ) => {
      setFeedbackEvents((prev) => {
        const next = recordSuggestionFeedback(
          prev,
          match,
          outcome,
          selectedProjectId,
        );
        saveSuggestionFeedback(next);
        return next;
      });
    },
    [],
  );

  const onConfirmSuggestion = useCallback(
    async (s: Suggestion) => {
      commitFeedback(s, "confirmed", s.project ?? null);
      await confirm();
    },
    [commitFeedback, confirm],
  );

  const onDismissSuggestion = useCallback(
    async (s: Suggestion) => {
      commitFeedback(s, "dismissed", null);
      await dismiss();
    },
    [commitFeedback, dismiss],
  );

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
      commitFeedback(suggestion, "dismissed", null);
      dismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [suggestion, detectionPrompts, commitFeedback, dismiss]);

  // #191 review/insight surfaces, all derived from the day's entries +
  // locally-recorded suggestion feedback — no new backend, no new persistence
  // beyond the feedback log.
  const learnedRuleCandidate = useMemo(() => {
    const candidate = bestLearnedRuleCandidate(feedbackEvents);
    if (!candidate) return null;
    if (dismissedLearningSignature === candidate.signature) return null;
    return candidate;
  }, [feedbackEvents, dismissedLearningSignature]);

  const reviewInbox = useMemo(
    () => buildReviewInbox(todayEntries, feedbackEvents),
    [todayEntries, feedbackEvents],
  );
  const focusInsights = useMemo(
    () => computeFocusInsights(todayEntries),
    [todayEntries],
  );
  const plannedVsActual = useMemo(
    () => plannedVsActualMinutes(todayEntries),
    [todayEntries],
  );

  // Re-entry is prevented by the button's `disabled={batchBusy}` — only the
  // chosen project (button disabled until one is picked) ever reaches here.
  const onBatchAssignUnassigned = useCallback(async () => {
    const targets = todayEntries.filter((e) => e.projectId === null);
    setBatchError(null);
    setBatchBusy(true);
    try {
      await Promise.all(
        targets.map((entry) =>
          updateEntry({ id: entry.id, projectId: reviewProjectId }),
        ),
      );
      await today.refresh();
    } catch (e) {
      setBatchError(
        `Couldn't apply batch assignment — ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setBatchBusy(false);
    }
  }, [reviewProjectId, todayEntries, today]);

  const persistDismissedLearning = useCallback((signature: string) => {
    setDismissedLearningSignature(signature);
    window.localStorage.setItem(DISMISSED_LEARNING_KEY, signature);
  }, []);

  // The candidate is passed in (narrowed at the call site); re-entry is
  // prevented by the button's `disabled={learningBusy}`.
  const onCreateLearnedRule = useCallback(
    async (candidate: LearnedRuleCandidate) => {
      setLearnError(null);
      setLearningBusy(true);
      try {
        const id = await rules.add();
        await rules.update(id, {
          name: `Learned: ${candidate.sampleRuleName}`,
          confidence: "suggestive",
          when: candidate.conditions.map((c) => ({
            signal: c.signal,
            op: defaultOpForSignal(c.signal),
            value: c.value,
          })),
          then: { project: candidate.projectId },
        });
        persistDismissedLearning(candidate.signature);
        onOpenRule(id);
      } catch (e) {
        setLearnError(
          `Couldn't save the rule — ${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        setLearningBusy(false);
      }
    },
    [rules, persistDismissedLearning, onOpenRule],
  );

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
    const sorted = [...closed].sort(
      (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
    );
    // Today shows just the latest few ("Recent"); a past day shows them all,
    // since this list is the only way to reach and edit that day's entries.
    return (isToday ? sorted.slice(0, 4) : sorted).map((e) => {
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
  }, [todayEntries, tasksById, isToday]);

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
      <header className="today-date-bar">
        <button
          type="button"
          className="today-date-step"
          aria-label="Previous day"
          onClick={() => stepDay(-1)}
        >
          <Icon name="chevron-left" size={16} />
        </button>
        <span className="today-date-label" aria-live="polite">
          {dateLabel}
        </span>
        <button
          type="button"
          className="today-date-step"
          aria-label="Next day"
          onClick={() => stepDay(1)}
          disabled={isToday}
        >
          <Icon name="chevron-right" size={16} />
        </button>
        {!isToday && (
          <button
            type="button"
            className="link-btn today-date-jump"
            onClick={() => setViewDate(todayIso)}
          >
            Today
          </button>
        )}
      </header>
      {isToday &&
        detectionPrompts !== "off" &&
        suggestion &&
        !switchCandidate && (
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
                onClick={() => void onDismissSuggestion(suggestion)}
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
                  void onDismissSuggestion(suggestion);
                  onOpenRule(id);
                }}
              >
                view rule
              </button>
            </div>
            <div className="suggest-actions">
              <button
                className="btn btn--primary"
                onClick={() => void onConfirmSuggestion(suggestion)}
              >
                <Icon name="check" size={13} /> Confirm
              </button>
              <button
                className="btn btn--ghost"
                onClick={() => {
                  // "Change…" = don't accept the rule's project; hide the
                  // banner and open the idle project picker so the user can
                  // choose what to start instead. Remember the suggestion so
                  // the picker's choice is recorded as a single "changed"
                  // outcome — we deliberately do NOT also record a "dismissed"
                  // here, which would double-count one correction.
                  setPendingChangedSuggestion(suggestion);
                  void dismiss();
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

      {isToday && (
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
                      if (pendingChangedSuggestion) {
                        commitFeedback(pendingChangedSuggestion, "changed", id);
                        setPendingChangedSuggestion(null);
                      }
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
      )}

      {isToday && layoutVariant === "projects-first" && (
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
        showNow={isToday}
      />

      {/* Always show the entries list on a past day — it's the surface for
          editing/deleting that day's entries — even under layouts that hide
          "Recent" today. */}
      {(!isToday || (!compact && layoutVariant !== "projects-first")) && (
        <section
          className="recent"
          aria-label={isToday ? "Recent entries" : "Logged entries"}
        >
          <div className="sect-label">
            <span>{isToday ? "Recent" : "Entries"}</span>
          </div>
          <RecentList
            entries={recentEntries}
            projectsById={projectsById}
            onEdit={onEditRecent}
            rounding={rounding}
            emptyToday={isToday}
          />
        </section>
      )}

      {isToday && (
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
      )}

      {isToday && (
        <>
          {learnedRuleCandidate && (
            <section className="data-block" aria-label="Rule learning prompt">
              <div className="sect-label">
                <span>Rule suggestion</span>
              </div>
              <p className="data-meta">
                Repeated pattern detected ({learnedRuleCandidate.confirms}{" "}
                confirms, {learnedRuleCandidate.changes} corrections). Save as
                an explicit rule?
              </p>
              <ul className="suggest-tags">
                {learnedRuleCandidate.conditions.map((condition) => (
                  <li
                    key={`${condition.signal}-${condition.value}`}
                    className="tag"
                  >
                    {condition.signal}: {condition.value}
                  </li>
                ))}
              </ul>
              <div className="suggest-actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void onCreateLearnedRule(learnedRuleCandidate)}
                  disabled={learningBusy}
                >
                  <Icon name="check" size={13} /> Save as rule
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() =>
                    persistDismissedLearning(learnedRuleCandidate.signature)
                  }
                  disabled={learningBusy}
                >
                  Dismiss
                </button>
              </div>
              {learnError && (
                <p className="now-stop-error" role="alert">
                  {learnError}
                </p>
              )}
            </section>
          )}

          <section className="data-block" aria-label="Review inbox">
            <div className="sect-label">
              <span>Review inbox</span>
            </div>
            {reviewInbox.length === 0 ? (
              <Empty
                title="No unresolved items"
                body="Suggestions and timeline gaps are clean right now."
                tone="soft"
              />
            ) : (
              <ul className="data-list">
                {reviewInbox.map((item) => (
                  <li key={item.id} className="data-row">
                    <span className="data-name">{item.title}</span>
                    <span className="data-meta">{item.detail}</span>
                  </li>
                ))}
              </ul>
            )}
            {reviewInbox.some((item) => item.kind === "no-project") && (
              <>
                <div className="data-add-row">
                  <select
                    className="field-input"
                    value={reviewProjectId ?? ""}
                    onChange={(e) =>
                      setReviewProjectId(
                        e.target.value === "" ? null : e.target.value,
                      )
                    }
                    aria-label="Project for batch assignment"
                  >
                    <option value="">Assign unassigned entries to…</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => void onBatchAssignUnassigned()}
                    disabled={!reviewProjectId || batchBusy}
                  >
                    Apply to unassigned
                  </button>
                </div>
                {batchError && (
                  <p className="now-stop-error" role="alert">
                    {batchError}
                  </p>
                )}
              </>
            )}
          </section>

          <section className="data-block" aria-label="Focus insights">
            <div className="sect-label">
              <span>Focus insights</span>
            </div>
            <ul className="data-list">
              <li className="data-row">
                <span className="data-name">Context switches</span>
                <span className="data-meta">
                  {focusInsights.contextSwitches}
                </span>
              </li>
              <li className="data-row">
                <span className="data-name">Deep work</span>
                <span className="data-meta">
                  {focusInsights.deepWorkBlocks} blocks ·{" "}
                  {fmtHm(focusInsights.deepWorkMinutes)}
                </span>
              </li>
              <li className="data-row">
                <span className="data-name">Fragmented blocks (≤15m)</span>
                <span className="data-meta">
                  {focusInsights.fragmentedBlocks}
                </span>
              </li>
              <li className="data-row">
                <span className="data-name">Meeting time</span>
                <span className="data-meta">
                  {fmtHm(focusInsights.meetingMinutes)}
                </span>
              </li>
            </ul>
          </section>

          <section className="data-block" aria-label="Planned versus actual">
            <div className="sect-label">
              <span>Planned vs actual</span>
            </div>
            <ul className="data-list">
              <li className="data-row">
                <span className="data-name">Planned (calendar)</span>
                <span className="data-meta">
                  {fmtHm(plannedVsActual.planned)}
                </span>
              </li>
              <li className="data-row">
                <span className="data-name">Actual (non-calendar)</span>
                <span className="data-meta">
                  {fmtHm(plannedVsActual.actual)}
                </span>
              </li>
              <li className="data-row">
                <span className="data-name">Drift</span>
                <span className="data-meta">
                  {plannedVsActual.drift >= 0 ? "+" : "-"}
                  {fmtHm(Math.abs(plannedVsActual.drift))}
                </span>
              </li>
            </ul>
          </section>
        </>
      )}

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
  /** Draw the live "now" marker + use today wording — false for a past day. */
  showNow: boolean;
}

function TimelineSection({
  entries,
  projects,
  announce,
  cbEnabled,
  showNow,
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
    <section className="timeline" aria-label="Timeline">
      <div className="sect-label">
        <span>{showNow ? "Today's path" : "Path"}</span>
        <span className="sect-meta">
          {fmtHm(Math.round(totalLoggedMin))} logged
        </span>
      </div>
      {entries.length === 0 ? (
        <Empty
          title={showNow ? "No entries yet today" : "No entries logged"}
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
            showNow={showNow}
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
  showNow: boolean;
}

function DayTimeline({
  segments,
  projects,
  nowMin,
  announce,
  cbEnabled,
  showNow,
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
        {showNow && (
          <div
            className="dt-now"
            style={{ left: `${nowPct}%` }}
            aria-label="Now"
            aria-live={announce ? "polite" : "off"}
          >
            <span className="dt-now-label">{fmtClock(Math.round(nowMin))}</span>
          </div>
        )}
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
