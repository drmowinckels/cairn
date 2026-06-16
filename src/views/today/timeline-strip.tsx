import { useEffect, useMemo, useRef, useState } from "react";
import { cbColor } from "../../lib/colorblind";
import { fmtClock } from "../../lib/time";
import {
  blockGeometry,
  dayWindow,
  entriesToSegments,
  hourTicks,
} from "../../lib/timeline";
import type { BackendEntry } from "../../lib/ipc";
import type { Project } from "../../lib/types";

const PX_PER_HOUR = 44;
const MIN_BLOCK_PX = 18;

function minutesNow(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

interface Props {
  entries: BackendEntry[];
  projects: Project[];
  announce: boolean;
  cbEnabled: boolean;
  /** Draw the live "now" rule and scroll it into view — false for a past day. */
  showNow: boolean;
  /** Open the editor for a clicked block. Omit to render read-only. */
  onEntryClick?: (id: string) => void;
}

/**
 * Vertical, scrollable day timeline (#188): entries render as colour-coded
 * blocks down a time axis, height proportional to duration, gaps left as empty
 * surface so "what didn't I track?" reads at a glance. Clicking a block opens
 * the entry editor; drag-resize lands in a follow-up PR.
 */
export function TimelineStrip({
  entries,
  projects,
  announce,
  cbEnabled,
  showNow,
  onEntryClick,
}: Props) {
  const [nowMin, setNowMin] = useState(() => minutesNow());
  useEffect(() => {
    const id = window.setInterval(() => setNowMin(minutesNow()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const segments = useMemo(
    () => entriesToSegments(entries, nowMin),
    [entries, nowMin],
  );
  const byId = useMemo(
    () => new Map(projects.map((p) => [p.id, p] as const)),
    [projects],
  );
  const win = useMemo(
    () => dayWindow(segments, nowMin, showNow),
    [segments, nowMin, showNow],
  );
  const ticks = useMemo(() => hourTicks(win), [win]);
  const canvasPx = ((win.endMin - win.startMin) / 60) * PX_PER_HOUR;
  const nowTop = ((nowMin - win.startMin) / 60) * PX_PER_HOUR;

  const scrollRef = useRef<HTMLDivElement>(null);
  // Bring the now-line roughly to the middle when opening on today.
  useEffect(() => {
    const el = scrollRef.current;
    if (!showNow || !el) return;
    el.scrollTop = Math.max(0, nowTop - el.clientHeight / 2);
    // Only on mount / when switching into today — not on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showNow]);

  return (
    <div
      className="vt"
      ref={scrollRef}
      role="group"
      aria-label={`Timeline from ${fmtClock(win.startMin)} to ${fmtClock(
        win.endMin,
      )}`}
    >
      <div className="vt-canvas" style={{ height: `${canvasPx}px` }}>
        <div className="vt-axis" aria-hidden="true">
          {ticks.map((m) => (
            <div
              key={m}
              className="vt-tick"
              style={{ top: `${((m - win.startMin) / 60) * PX_PER_HOUR}px` }}
            >
              <span className="vt-tick-label">{fmtClock(m)}</span>
            </div>
          ))}
        </div>
        <div className="vt-track">
          {segments.map((s) => {
            const { topPx, heightPx } = blockGeometry(
              s.startMin,
              s.endMin,
              win,
              PX_PER_HOUR,
              MIN_BLOCK_PX,
            );
            const proj = s.projectId ? byId.get(s.projectId) : undefined;
            const color = cbColor(proj?.color ?? "var(--ink-mute)", cbEnabled);
            const name = proj?.name ?? "Uncategorized";
            const label = s.description ? `${name} · ${s.description}` : name;
            return (
              <button
                key={s.id}
                type="button"
                className={`vt-seg${s.running ? " is-running" : ""}`}
                style={{ top: `${topPx}px`, height: `${heightPx}px` }}
                title={label}
                aria-label={`Edit ${label}`}
                disabled={!onEntryClick}
                onClick={() => onEntryClick?.(s.id)}
              >
                <span
                  className="vt-seg-bar"
                  style={{ background: color }}
                  aria-hidden="true"
                />
                <span className="vt-seg-body">
                  <span className="vt-seg-name">{name}</span>
                  {s.description && (
                    <span className="vt-seg-desc">{s.description}</span>
                  )}
                </span>
              </button>
            );
          })}
          {showNow && (
            <div
              className="vt-now"
              style={{ top: `${nowTop}px` }}
              aria-label="Now"
              aria-live={announce ? "polite" : "off"}
            >
              <span className="vt-now-label">{fmtClock(nowMin)}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
