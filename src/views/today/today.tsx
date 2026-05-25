import { useEffect, useState } from "react";
import { Icon } from "../../lib/icon";
import { Empty, ErrorBanner, ProjectChip, Tag } from "../../lib/components";
import { fmtClock, fmtClockFromIso, fmtHm, fmtIdleDuration, fmtRange } from "../../lib/time";
import { useTimer } from "../../lib/use-timer";
import { useSuggestion } from "../../lib/use-suggestion";
import { useIdlePrompt } from "../../lib/use-idle-prompt";
import type { Density, DetectionPrompts, LayoutVariant } from "../../lib/types";
import {
  NOW_MIN,
  PROJECT_BY_ID,
  PROJECTS,
  RUNNING,
  TODAY,
  UPCOMING,
} from "../../test-fixtures/data";

interface Props {
  density: Density;
  layoutVariant: LayoutVariant;
  onOpenRule: (id: string) => void;
  showIdleModal: boolean;
  setShowIdleModal: (v: boolean) => void;
  detectionPrompts?: DetectionPrompts;
  announce?: boolean;
}

export function TodayView({
  density,
  layoutVariant,
  onOpenRule,
  showIdleModal,
  setShowIdleModal,
  detectionPrompts = "subtle",
  announce = true,
}: Props) {
  const compact = density === "compact";
  const timer = useTimer();
  // The hook owns banner visibility internally — dismissed
  // suggestions clear via the snooze map per RULES_ENGINE.md §6,
  // and Strict matches skip the banner entirely. The popover used
  // to track `suggestionDismissed` as a session boolean; that's
  // gone now because it permanently silenced the banner after the
  // first dismiss, even after the snooze expired.
  const { suggestion, confirm, dismiss } = useSuggestion({
    currentRunningRuleId: timer.running?.ruleId ?? null,
  });
  const idle = useIdlePrompt({
    runningEntryId: timer.running?.id ?? null,
  });

  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const runningProject = timer.running?.projectId ?? RUNNING.project;
  const runningTask = timer.running?.description ?? RUNNING.description;
  const runningTags = [] as string[];
  const runningSource = timer.running ? deriveSource(timer.running) : "rule";

  const startedAt = timer.running
    ? new Date(timer.running.startedAt).getTime()
    : null;
  const runSec = startedAt
    ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) + tick * 0
    : (NOW_MIN - RUNNING.start) * 60 + 14 + tick;
  const hh = String(Math.floor(runSec / 3600)).padStart(2, "0");
  const mm = String(Math.floor((runSec % 3600) / 60)).padStart(2, "0");
  const ss = String(runSec % 60).padStart(2, "0");

  const onStop = () => {
    timer.stop().catch((e) => console.error("stop failed", e));
  };
  const onQuickStart = (projectId: string) => {
    timer.start({ projectId, description: "" }).catch((e) => console.error("start failed", e));
  };

  return (
    <div className="view view-today" data-density={density}>
      {detectionPrompts !== "off" && suggestion && (
        <section
          className={`suggest suggest--${detectionPrompts}`}
          aria-label="Auto-detected work"
          aria-live={announce ? "polite" : "off"}
          role={detectionPrompts === "modal" ? "alertdialog" : undefined}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              dismiss();
            } else if (e.key === "Enter") {
              void confirm();
            }
          }}
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
                // Viewing the rule acks the suggestion. Without
                // this the banner stays pinned on return, with
                // potentially stale `ruleName` if the user renamed
                // the rule in the editor.
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
              // Legacy fixture path used by Storybook/preview when
              // no live event arrives. Kept so the modal renders
              // for design review.
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
            {timer.loading ? "Connecting…" : "Now · running"}
          </span>
          {!timer.loading && (
            <span
              className="now-source"
              title={
                runningSource === "rule"
                  ? "Started automatically by a rule"
                  : "Started manually"
              }
            >
              <Icon name="sparkle" size={11} /> {runningSource}
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
        <div className="now-task">
          <input
            key={timer.running?.id ?? "fixture"}
            className="now-input"
            defaultValue={runningTask}
            aria-label="Task description"
            placeholder="What are you working on?"
          />
        </div>
        <div className="now-row">
          <div className="now-chips">
            {runningProject && <ProjectChip id={runningProject} interactive />}
            {runningTags.map((t) => (
              <Tag key={t}>{t}</Tag>
            ))}
          </div>
          <button
            className="btn btn--stop"
            aria-label="Stop timer"
            onClick={onStop}
            disabled={timer.running == null}
          >
            <Icon name="stop" size={12} /> Stop
          </button>
        </div>
      </section>

      {layoutVariant === "projects-first" && (
        <section className="quick" aria-label="Quick-start a project">
          <div className="sect-label">Quick start</div>
          <div className="quick-grid">
            {PROJECTS.slice(0, 4).map((p) => (
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
        </section>
      )}

      <section className="timeline" aria-label="Today's timeline">
        <div className="sect-label">
          <span>Today's path</span>
          <span className="sect-meta">
            {fmtHm(4 * 60 + 12)} logged · {fmtHm(18 * 60 + 34)} this week
          </span>
        </div>
        <DayTimeline />
        <div className="legend">
          {[...new Set(TODAY.map((t) => t.project).concat([RUNNING.project]))].map((pid) => (
            <span key={pid} className="legend-item">
              <span
                className="proj-dot"
                style={{ background: PROJECT_BY_ID[pid].color }}
              />
              {PROJECT_BY_ID[pid].name}
            </span>
          ))}
        </div>
      </section>

      {!compact && layoutVariant !== "projects-first" && (
        <section className="recent" aria-label="Recent entries">
          <div className="sect-label">
            <span>Recent</span>
            <button className="link-btn">Edit…</button>
          </div>
          {TODAY.length === 0 ? (
            <Empty
              title="No entries yet today"
              body="Start a timer or let a rule catch what you're doing."
            />
          ) : (
            <ul className="entries">
              {[...TODAY].reverse().slice(0, 4).map((e, i) => (
                <li key={i} className="entry">
                  <span className="entry-time">{fmtClock(e.start)}</span>
                  <span
                    className="proj-dot"
                    style={{ background: PROJECT_BY_ID[e.project].color }}
                  />
                  <span className="entry-task">{e.description}</span>
                  <span className="entry-dur">{fmtHm(e.end - e.start)}</span>
                  {e.source.startsWith("rule") && <Icon name="sparkle" size={10} className="entry-src" />}
                  {e.source === "calendar" && <Icon name="calendar" size={10} className="entry-src" />}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="upcoming">
        <div className="sect-label">
          <span>Up next</span>
        </div>
        {UPCOMING.length === 0 ? (
          <Empty
            title="Nothing scheduled"
            body="Calendar events show up here as they approach."
            tone="soft"
          />
        ) : (
          <ul className="up-list">
            {UPCOMING.map((u, i) => (
              <li key={i} className="up-item">
                <span className="up-time">{fmtClock(u.at)}</span>
                <span className="up-label">{u.label}</span>
                <span className="up-dur">{u.duration}m</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function deriveSource(entry: { source: string }): string {
  if (entry.source.startsWith("rule")) return "rule";
  if (entry.source === "calendar") return "calendar";
  return "manual";
}

const DAY_START = 8 * 60;
const DAY_END = 19 * 60;
const DAY_SPAN = DAY_END - DAY_START;

function DayTimeline() {
  const pct = (m: number) => ((m - DAY_START) / DAY_SPAN) * 100;
  const nowPct = pct(NOW_MIN);

  const entries = [
    ...TODAY,
    {
      start: RUNNING.start,
      end: NOW_MIN,
      project: RUNNING.project,
      description: RUNNING.description,
      running: true,
    },
  ];

  return (
    <div className="dt-wrap" role="img" aria-label="Today's timeline from 08:00 to 19:00">
      <div className="dt-track">
        {entries.map((e, i) => (
          <div
            key={i}
            className={`dt-seg${"running" in e && e.running ? " is-running" : ""}`}
            style={{
              left: `${pct(e.start)}%`,
              width: `${pct(e.end) - pct(e.start)}%`,
              background: PROJECT_BY_ID[e.project].color,
            }}
            title={`${e.description} · ${fmtRange(e.start, e.end)}`}
          />
        ))}
        <div className="dt-now" style={{ left: `${nowPct}%` }} aria-label="Now">
          <span className="dt-now-label">{fmtClock(NOW_MIN)}</span>
        </div>
      </div>
      <div className="dt-axis">
        {[8, 10, 12, 14, 16, 18].map((h) => (
          <span key={h} className="dt-tick" style={{ left: `${pct(h * 60)}%` }}>
            {h}
          </span>
        ))}
      </div>
    </div>
  );
}
