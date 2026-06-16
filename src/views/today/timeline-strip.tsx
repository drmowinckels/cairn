import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cbColor } from "../../lib/colorblind";
import { fmtClock } from "../../lib/time";
import {
  applyMinuteToIso,
  blockGeometry,
  dayWindow,
  entriesToSegments,
  hourTicks,
  resizeSegment,
  type ResizeEdge,
} from "../../lib/timeline";
import type { BackendEntry } from "../../lib/ipc";
import type { Project } from "../../lib/types";

const PX_PER_HOUR = 44;
const MIN_BLOCK_PX = 18;
const SNAP_MIN = 5;

function minutesNow(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

/** A resize edit ready to persist. Carries only the edge that moved. */
export interface ResizePatch {
  startedAt?: string;
  endedAt?: string;
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
  /** Persist a drag-resize. Omit to disable edge handles. */
  onResize?: (id: string, patch: ResizePatch) => void;
}

interface DragState {
  id: string;
  edge: ResizeEdge;
  startClientY: number;
  origStartMin: number;
  origEndMin: number;
  curStartMin: number;
  curEndMin: number;
  /** ISO of the moved edge, captured at pointer-down, re-timed on commit. */
  base: string;
  commit: (id: string, patch: ResizePatch) => void;
}

/**
 * Vertical, scrollable day timeline (#188): entries render as colour-coded
 * blocks down a time axis, height proportional to duration, gaps left as empty
 * surface so "what didn't I track?" reads at a glance. Clicking a block opens
 * the editor; dragging a block's top/bottom edge resizes its start/end time.
 *
 * Edge-drag is a pointer-only progressive enhancement (handles are
 * `aria-hidden`); keyboard users change times through the editor the block
 * click opens, so no keyboard-resize affordance is needed.
 */
export function TimelineStrip({
  entries,
  projects,
  announce,
  cbEnabled,
  showNow,
  onEntryClick,
  onResize,
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

  // --- drag-resize -------------------------------------------------------
  // Window listeners live for the component's lifetime and gate on `dragRef`,
  // so they never go stale, never need re-binding, and the "no drag" guard is
  // exercised by ordinary pointer movement. Everything the commit needs (the
  // ISO base + the persist callback) is captured into the drag state at
  // pointer-down, so the handler needs no lookups.
  const dragRef = useRef<DragState | null>(null);
  const [preview, setPreview] = useState<{
    id: string;
    startMin: number;
    endMin: number;
  } | null>(null);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const deltaMin = ((e.clientY - d.startClientY) / PX_PER_HOUR) * 60;
      const r = resizeSegment(
        d.edge,
        d.origStartMin,
        d.origEndMin,
        deltaMin,
        SNAP_MIN,
      );
      d.curStartMin = r.startMin;
      d.curEndMin = r.endMin;
      setPreview({ id: d.id, startMin: r.startMin, endMin: r.endMin });
    };
    const onUp = () => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      setPreview(null);
      if (d.edge === "start") {
        if (d.curStartMin !== d.origStartMin) {
          d.commit(d.id, {
            startedAt: applyMinuteToIso(d.base, d.curStartMin),
          });
        }
      } else if (d.curEndMin !== d.origEndMin) {
        d.commit(d.id, { endedAt: applyMinuteToIso(d.base, d.curEndMin) });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const beginResize = useCallback(
    (
      e: React.PointerEvent,
      entry: BackendEntry,
      edge: ResizeEdge,
      startMin: number,
      endMin: number,
      commit: (id: string, patch: ResizePatch) => void,
    ) => {
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = {
        id: entry.id,
        edge,
        startClientY: e.clientY,
        origStartMin: startMin,
        origEndMin: endMin,
        curStartMin: startMin,
        curEndMin: endMin,
        // Handles only render on closed entries, so `endedAt` is set there.
        base: edge === "start" ? entry.startedAt : entry.endedAt!,
        commit,
      };
      setPreview({ id: entry.id, startMin, endMin });
    },
    [],
  );

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
          {segments.map((s, i) => {
            // `entriesToSegments` maps 1:1 in order, so `entries[i]` is the
            // backend entry behind this segment — used to capture the ISO
            // timestamps a resize commit re-times.
            const entry = entries[i]!;
            const drawStart =
              preview?.id === s.id ? preview.startMin : s.startMin;
            const drawEnd = preview?.id === s.id ? preview.endMin : s.endMin;
            const { topPx, heightPx } = blockGeometry(
              drawStart,
              drawEnd,
              win,
              PX_PER_HOUR,
              MIN_BLOCK_PX,
            );
            const proj = s.projectId ? byId.get(s.projectId) : undefined;
            const color = cbColor(proj?.color ?? "var(--ink-mute)", cbEnabled);
            const name = proj?.name ?? "Uncategorized";
            const label = s.description ? `${name} · ${s.description}` : name;
            // Closed entries can be edge-resized; the running entry's end is
            // "now", so it isn't a handle target.
            const commit = s.running ? undefined : onResize;
            return (
              <div key={s.id}>
                <button
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
                {commit && (
                  <>
                    <div
                      className="vt-handle vt-handle--top"
                      style={{ top: `${topPx}px` }}
                      aria-hidden="true"
                      onPointerDown={(e) =>
                        beginResize(
                          e,
                          entry,
                          "start",
                          s.startMin,
                          s.endMin,
                          commit,
                        )
                      }
                    />
                    <div
                      className="vt-handle vt-handle--bottom"
                      style={{ top: `${topPx + heightPx}px` }}
                      aria-hidden="true"
                      onPointerDown={(e) =>
                        beginResize(
                          e,
                          entry,
                          "end",
                          s.startMin,
                          s.endMin,
                          commit,
                        )
                      }
                    />
                  </>
                )}
              </div>
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
