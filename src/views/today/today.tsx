import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../lib/icon";
import { Empty, ErrorBanner, ProjectChip, Tag } from "../../lib/components";
import {
  fmtClock,
  fmtClockFromIso,
  fmtHm,
  fmtIdleDuration,
} from "../../lib/time";
import { useTimer } from "../../lib/use-timer";
import { useSuggestion } from "../../lib/use-suggestion";
import { useIdlePrompt } from "../../lib/use-idle-prompt";
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
import { inTauri, type BackendEntry } from "../../lib/ipc";
import type { Density, DetectionPrompts, LayoutVariant, Project } from "../../lib/types";
import { RecentList, type RecentEntry } from "./recent-list";
import { UpcomingList, type UpcomingEvent } from "./upcoming-list";
import {
  isoToLocal,
  ManualEntryModal,
  type ManualEntryDraft,
  type ManualEntrySubmit,
} from "./manual-entry-modal";

interface Props {
  density: Density;
  layoutVariant: LayoutVariant;
  onOpenRule: (id: string) => void;
  showIdleModal: boolean;
  setShowIdleModal: (v: boolean) => void;
  detectionPrompts?: DetectionPrompts;
  announce?: boolean;
  /**
   * Increment this number from the popover header's `+` button to
   * open the manual-entry modal in create mode (#21).
   */
  addEntryRequest?: number;
}

export function TodayView({
  density,
  layoutVariant,
  onOpenRule,
  showIdleModal,
  setShowIdleModal,
  detectionPrompts = "subtle",
  announce = true,
  addEntryRequest = 0,
}: Props) {
  const compact = density === "compact";
  const projects = useProjects();
  const today = useToday();
  const upcoming = useUpcoming(3);
  const calendars = useCalendars();
  const timer = useTimer({ onStopped: () => void today.refresh() });
  const { suggestion, confirm, dismiss } = useSuggestion({
    currentRunningRuleId: timer.running?.ruleId ?? null,
  });
  const idle = useIdlePrompt({
    runningEntryId: timer.running?.id ?? null,
  });

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

  const onStop = useCallback(() => {
    debouncedDesc.flush();
    timer.stop().catch((e) => console.error("stop failed", e));
  }, [debouncedDesc, timer]);

  const onQuickStart = (projectId: string) => {
    timer
      .start({ projectId, description: "" })
      .then(() => today.refresh())
      .catch((e) => console.error("start failed", e));
  };

  const todayEntries = today.entries;
  const projectsById = useMemo(() => projectById(projects), [projects]);

  useEffect(() => {
    if (!suggestion || detectionPrompts === "off") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [suggestion, detectionPrompts, dismiss]);

  // ── manual-entry modal (#21) ────────────────────────────────────
  const [modalState, setModalState] = useState<
    | { open: false }
    | { open: true; mode: "create" | "edit"; draft: ManualEntryDraft }
  >({ open: false });

  const openCreate = useCallback(() => {
    const now = new Date();
    const start = new Date(now.getTime() - 30 * 60_000);
    setModalState({
      open: true,
      mode: "create",
      draft: {
        projectId: null,
        description: "",
        startedLocal: isoToLocal(start.toISOString()),
        endedLocal: isoToLocal(now.toISOString()),
      },
    });
  }, []);

  const openEdit = useCallback((entry: BackendEntry) => {
    setModalState({
      open: true,
      mode: "edit",
      draft: {
        id: entry.id,
        projectId: entry.projectId,
        description: entry.description,
        startedLocal: isoToLocal(entry.startedAt),
        endedLocal: isoToLocal(entry.endedAt ?? ""),
      },
    });
  }, []);

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
      if (payload.id) {
        await today.update({
          id: payload.id,
          projectId: payload.projectId,
          description: payload.description,
          startedAt: payload.startedAt,
          endedAt: payload.endedAt,
        });
      } else {
        await today.create({
          projectId: payload.projectId,
          description: payload.description,
          startedAt: payload.startedAt,
          endedAt: payload.endedAt,
          source: "manual",
        });
      }
      void timer.refresh();
    },
    [today, timer],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      await today.remove(id);
      void timer.refresh();
    },
    [today, timer],
  );

  const recentEntries = useMemo<RecentEntry[]>(() => {
    const closed = todayEntries.filter((e) => e.endedAt !== null);
    return [...closed]
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, 4)
      .map((e) => ({
        id: e.id,
        projectId: e.projectId,
        description: e.description,
        startedAt: e.startedAt,
        endedAt: e.endedAt,
        source: e.source,
      }));
  }, [todayEntries]);

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
      {detectionPrompts !== "off" && suggestion && (
        <section
          className={`suggest suggest--${detectionPrompts}`}
          aria-label="Auto-detected work"
          aria-live={announce ? "polite" : "off"}
          role={detectionPrompts === "modal" ? "alertdialog" : undefined}
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
                Working on <ProjectChip id={suggestion.project} />
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
            <button
              className="btn btn--primary"
              onClick={() => void confirm()}
            >
              <Icon name="check" size={13} /> Confirm
            </button>
            <button
              className="btn btn--ghost"
              onClick={() => dismiss()}
            >
              Change…
            </button>
          </div>
        </section>
      )}

      {(showIdleModal || idle.prompt) && (
        <section className="idle" role="alertdialog" aria-labelledby="idle-h">
          <div className="idle-head">
            <Icon name="moon" size={14} /> <span id="idle-h">You were away</span>
          </div>
          <div className="idle-body">
            {idle.prompt ? (
              <>
                No input detected from{" "}
                <strong>{fmtClockFromIso(idle.prompt.since)}</strong> to{" "}
                <strong>{fmtClockFromIso(idle.prompt.until)}</strong>
                <span className="idle-dur">
                  {fmtIdleDuration(idle.prompt.durationSeconds)}
                </span>
              </>
            ) : (
              <>
                No input detected from <strong>14:50</strong> to <strong>15:02</strong>
                <span className="idle-dur">12 min</span>
              </>
            )}
          </div>
          <div className="idle-actions">
            <button
              className="btn btn--primary"
              onClick={() => {
                void idle.keep();
                setShowIdleModal(false);
              }}
            >
              Keep
            </button>
            <button
              className="btn btn--ghost"
              onClick={() => {
                void idle.discard();
                setShowIdleModal(false);
              }}
            >
              Discard idle
            </button>
            <button
              className="btn btn--ghost"
              onClick={() => {
                void idle.moveToBreak();
                setShowIdleModal(false);
              }}
            >
              Move to break
            </button>
          </div>
        </section>
      )}

      {timer.error && (
        <ErrorBanner
          message={`Couldn't reach the local timer service — ${timer.error}`}
          onRetry={() => timer.refresh()}
        />
      )}

      <section className="now" aria-label="Current timer" aria-busy={timer.loading}>
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
        {timer.running ? (
          <>
            <div className="now-task">
              <input
                key={timer.running.id}
                className="now-input"
                defaultValue={runningTask}
                aria-label="Task description"
                placeholder="What are you working on?"
                onChange={(e) => debouncedDesc(e.currentTarget.value)}
                onBlur={() => debouncedDesc.flush()}
              />
            </div>
            <div className="now-row">
              <div className="now-chips">
                <ProjectPickerChip
                  projectId={runningProject}
                  projects={projects}
                  open={pickerOpen}
                  setOpen={setPickerOpen}
                  onPick={onPickProject}
                />
              </div>
              <button
                className="btn btn--stop"
                aria-label="Stop timer"
                onClick={onStop}
              >
                <Icon name="stop" size={12} /> Stop
              </button>
            </div>
          </>
        ) : (
          !timer.loading && (
            <div className="now-row">
              <div className="now-chips">
                <span className="now-idle-hint">
                  No timer running — start one from Quick start or pick a project.
                </span>
              </div>
              <button
                className="btn btn--stop"
                aria-label="Stop timer"
                disabled
              >
                <Icon name="stop" size={12} /> Stop
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
                    style={{ background: p.color, width: 8, height: 8 }}
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
}: ProjectPickerChipProps) {
  const current = projectId ? projects.find((p) => p.id === projectId) : undefined;
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
      <button
        type="button"
        className="proj-chip is-interactive"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-disabled={!hasProjects}
        aria-label={
          current ? `Project: ${current.name}. Change project` : "Choose a project"
        }
        onClick={() => hasProjects && setOpen(!open)}
      >
        <span
          className="proj-dot"
          style={{ background: current?.color ?? "var(--ink-mute)" }}
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
                  style={{ background: p.color }}
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
}

function TimelineSection({ entries, projects, announce }: TimelineSectionProps) {
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
      segments.reduce(
        (acc, s) => acc + Math.max(0, s.endMin - s.startMin),
        0,
      ),
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
          />
          <ul className="legend">
            {legend.map((l) => (
              <li key={l.projectId} className="legend-item">
                <span className="proj-dot" style={{ background: l.color }} />
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
}

function DayTimeline({ segments, projects, nowMin, announce }: DayTimelineProps) {
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
          const color = s.projectId
            ? (byId[s.projectId]?.color ?? "var(--ink-mute)")
            : "var(--ink-mute)";
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
