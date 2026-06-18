import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../lib/icon";
import { cbColor } from "../../lib/colorblind";
import { fmtClock } from "../../lib/time";
import {
  applyMinuteToIso,
  blockGeometry,
  canMerge,
  dayWindow,
  entriesToSegments,
  hourTicks,
  resizeSegment,
  splitAt,
  splitMidpoint,
  type ResizeEdge,
} from "../../lib/timeline";
import { useMinuteClock } from "../../lib/use-minute-clock";
import { useAnnounce } from "../../lib/use-announce";
import type { BackendEntry } from "../../lib/ipc";
import type { Project } from "../../lib/types";

const PX_PER_HOUR = 44;
const MIN_BLOCK_PX = 18;
const SNAP_MIN = 5;
const LONG_PRESS_MS = 500;

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
  /** Split an entry at a minute-of-day into two. Omit to disable splitting. */
  onSplit?: (entry: BackendEntry, splitMin: number) => void;
  /** Merge two entries into one. Omit to disable merging. */
  onMerge?: (a: BackendEntry, b: BackendEntry) => void;
}

/** Which block's split menu is open, and where its time anchor lives. */
interface SplitMenu {
  entry: BackendEntry;
  splitMin: number;
  /** Pixel offset of the cursor within the canvas, for menu placement. */
  topPx: number;
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
  onSplit,
  onMerge,
}: Props) {
  const nowMin = useMinuteClock();

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

  // --- split (context-menu / long-press) -------------------------------
  // A right-click or long-press on a closed block maps the cursor's Y offset
  // within the block to a minute-of-day, snaps it to the resize grid, and (when
  // it lands strictly inside the block) opens a one-item "Split here" menu.
  const [splitMenu, setSplitMenu] = useState<SplitMenu | null>(null);
  const longPressRef = useRef<number | null>(null);
  const splitItemRef = useRef<HTMLButtonElement>(null);
  // The window changes as the day grows; the menu's pixel anchor reads it
  // through a ref so the open handler isn't re-created every tick.
  const winRef = useRef(win);
  winRef.current = win;

  // Map the cursor's Y within a block to a snapped, in-bounds minute-of-day,
  // resolved synchronously at the event (a long-press reads it before arming
  // its timer, so the rect is sampled while the target is still live).
  const splitMinFor = useCallback(
    (
      clientY: number,
      target: HTMLElement,
      startMin: number,
      endMin: number,
    ) => {
      const rect = target.getBoundingClientRect();
      const frac = (clientY - rect.top) / Math.max(1, rect.height);
      const raw = startMin + frac * (endMin - startMin);
      return splitAt(startMin, endMin, raw, SNAP_MIN);
    },
    [],
  );

  const openSplitMenu = useCallback(
    (entry: BackendEntry, splitMin: number | null) => {
      if (splitMin === null) return;
      const win = winRef.current;
      const topPx = ((splitMin - win.startMin) / 60) * PX_PER_HOUR;
      setSplitMenu({ entry, splitMin, topPx });
    },
    [],
  );

  const clearLongPress = useCallback(() => {
    if (longPressRef.current !== null) {
      window.clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
  }, []);

  // --- merge (select mode) ---------------------------------------------
  // A toggle puts the strip in "select" mode; tapping blocks marks up to two.
  // When the two are mergeable (same project, adjacent, both closed) the Merge
  // action lights up. Leaving select mode clears the marks.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      // Keep at most two: a third tap drops the oldest.
      return [...prev, id].slice(-2);
    });
  }, []);

  const exitSelect = useCallback(() => {
    setSelectMode(false);
    setSelected([]);
  }, []);

  // --- split (keyboard select mode) ------------------------------------
  // The accessible counterpart to the pointer split menu: a toolbar toggle
  // puts the strip in "split" mode, where activating a block (click or Enter)
  // cuts it in two at its snapped midpoint — no pointer position needed. The
  // result is routed to the app's shared live region (which honors the
  // screen-reader-announcements pref), like timer/suggestion announcements.
  const announceMsg = useAnnounce();
  const [splitMode, setSplitMode] = useState(false);
  // Focus target for when a split leaves the original block too short to split
  // again: it becomes `disabled` after the refresh and would drop focus to the
  // body, so we move focus to this always-present control instead.
  const splitCancelRef = useRef<HTMLButtonElement>(null);

  // The two keyboard modes are mutually exclusive: entering one leaves the
  // other (and clears the pointer menu) so the toolbar only ever shows one
  // mode's controls.
  const enterSelectMode = useCallback(() => {
    setSelectMode(true);
    setSplitMode(false);
    setSplitMenu(null);
  }, []);

  const enterSplitMode = useCallback(() => {
    setSplitMode(true);
    setSelectMode(false);
    setSelected([]);
    setSplitMenu(null);
  }, []);

  const exitSplitMode = useCallback(() => {
    setSplitMode(false);
  }, []);

  const mergePair = useMemo(() => {
    // Resolve the marked ids against the live entries; if either no longer
    // exists (the day refreshed under the selection) there's no pair to merge.
    const picked = selected
      .map((id) => entries.find((e) => e.id === id))
      .filter((e): e is BackendEntry => e !== undefined);
    if (picked.length !== 2) return null;
    const [a, b] = picked;
    if (!canMerge(a!, b!)) return null;
    return { a: a!, b: b! };
  }, [selected, entries]);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Bring the now-line roughly to the middle when opening on today.
  useEffect(() => {
    const el = scrollRef.current;
    if (!showNow || !el) return;
    el.scrollTop = Math.max(0, nowTop - el.clientHeight / 2);
    // Only on mount / when switching into today — not on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showNow]);

  // Esc closes the split menu; a pointer-down outside it dismisses it too.
  useEffect(() => {
    if (!splitMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSplitMenu(null);
    };
    const onDown = (e: PointerEvent) => {
      if (
        e.target instanceof Node &&
        !(e.target as Element).closest?.(".vt-split-menu")
      ) {
        setSplitMenu(null);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    // Move focus into the menu so keyboard users land on the action; Esc or an
    // outside click closes it (handled above).
    splitItemRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [splitMenu]);

  const mergeReady = mergePair !== null;

  return (
    <div className="vt-wrap">
      {(onMerge || onSplit) && (
        <div className="vt-toolbar">
          {selectMode ? (
            <>
              <span className="vt-toolbar-hint" aria-live="polite">
                {selected.length === 0
                  ? "Pick two adjacent blocks in the same project"
                  : selected.length === 1
                    ? "Pick one more to merge"
                    : mergeReady
                      ? "Ready to merge"
                      : "Those two can't merge — pick adjacent, same-project blocks"}
              </span>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                disabled={!mergePair}
                onClick={
                  mergePair
                    ? () => {
                        onMerge!(mergePair.a, mergePair.b);
                        exitSelect();
                      }
                    : undefined
                }
              >
                <Icon name="merge" size={12} /> Merge
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={exitSelect}
              >
                Cancel
              </button>
            </>
          ) : splitMode ? (
            <>
              <span className="vt-toolbar-hint" aria-live="polite">
                Pick a block to split it in two at its midpoint
              </span>
              <button
                ref={splitCancelRef}
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={exitSplitMode}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              {onMerge && (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={enterSelectMode}
                >
                  <Icon name="merge" size={12} /> Select to merge
                </button>
              )}
              {onSplit && (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={enterSplitMode}
                >
                  <Icon name="scissors" size={12} /> Split
                </button>
              )}
            </>
          )}
        </div>
      )}
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
              const color = cbColor(
                proj?.color ?? "var(--ink-mute)",
                cbEnabled,
              );
              const name = proj?.name ?? "Uncategorized";
              const label = s.description ? `${name} · ${s.description}` : name;
              // Closed, same-day entries can be edge-resized OR split. The
              // running entry's end is "now", and a clamped (past-midnight)
              // entry's end isn't on this day — neither is a handle/split
              // target; edit via the modal (click the block).
              const editable = !s.running && !s.clamped;
              const commit = editable ? onResize : undefined;
              const splittable = editable && Boolean(onSplit);
              const isSelected = selected.includes(s.id);

              // Only closed, same-day entries can be marked for merge — same
              // constraint as split. A running/clamped block has no mergeable
              // span on this day, so it's `disabled` in select mode (below) and
              // its click never reaches here — no guard needed in the handler.
              const selectable = editable;

              // Keyboard split: the snapped midpoint this block would cut at,
              // or null when it's not splittable or too short to hold an
              // interior grid point. Drives the split-mode label, disabled
              // state, midpoint marker, and the activate action below.
              const splitSeedMin = splittable
                ? splitMidpoint(s.startMin, s.endMin, SNAP_MIN)
                : null;
              const splitAction =
                splitMode && splitSeedMin !== null
                  ? () => {
                      onSplit!(entry, splitSeedMin);
                      announceMsg(
                        `Split ${name} at ${fmtClock(
                          splitSeedMin,
                        )} into two entries.`,
                      );
                      // The original block keeps focus across the refresh
                      // unless the first half it shrinks to (start → split) is
                      // too short to split again — then it goes `disabled` and
                      // drops focus. Pre-empt that by moving focus to Cancel.
                      if (
                        splitMidpoint(s.startMin, splitSeedMin, SNAP_MIN) ===
                        null
                      ) {
                        splitCancelRef.current?.focus();
                      }
                    }
                  : null;

              const onSegClick = () => {
                if (selectMode) {
                  toggleSelect(s.id);
                  return;
                }
                if (splitAction) {
                  splitAction();
                  return;
                }
                onEntryClick?.(s.id);
              };

              return (
                <div key={s.id}>
                  <button
                    type="button"
                    className={`vt-seg${s.running ? " is-running" : ""}${
                      isSelected ? " is-selected" : ""
                    }`}
                    style={{ top: `${topPx}px`, height: `${heightPx}px` }}
                    title={label}
                    aria-label={
                      selectMode
                        ? selectable
                          ? `Select ${label}`
                          : `${label} — can't be merged`
                        : splitMode
                          ? splitSeedMin !== null
                            ? `Split ${label} at its midpoint, ${fmtClock(
                                splitSeedMin,
                              )}`
                            : `${label} — can't be split`
                          : `Edit ${label}`
                    }
                    aria-pressed={
                      selectMode && selectable ? isSelected : undefined
                    }
                    disabled={
                      selectMode
                        ? !selectable
                        : splitMode
                          ? splitSeedMin === null
                          : !onEntryClick
                    }
                    onClick={onSegClick}
                    onContextMenu={
                      splittable && !selectMode && !splitMode
                        ? (e) => {
                            e.preventDefault();
                            openSplitMenu(
                              entry,
                              splitMinFor(
                                e.clientY,
                                e.currentTarget,
                                s.startMin,
                                s.endMin,
                              ),
                            );
                          }
                        : undefined
                    }
                    onPointerDown={
                      splittable && !selectMode && !splitMode
                        ? (e) => {
                            if (e.pointerType !== "touch") return;
                            const splitMin = splitMinFor(
                              e.clientY,
                              e.currentTarget,
                              s.startMin,
                              s.endMin,
                            );
                            clearLongPress();
                            longPressRef.current = window.setTimeout(() => {
                              openSplitMenu(entry, splitMin);
                            }, LONG_PRESS_MS);
                          }
                        : undefined
                    }
                    onPointerUp={splittable ? clearLongPress : undefined}
                    onPointerLeave={splittable ? clearLongPress : undefined}
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
                  {commit && !selectMode && !splitMode && (
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
                  {splitMode && splitSeedMin !== null && (
                    <div
                      className="vt-split-mark"
                      style={{
                        top: `${
                          ((splitSeedMin - win.startMin) / 60) * PX_PER_HOUR
                        }px`,
                      }}
                      aria-hidden="true"
                    >
                      <span className="vt-split-mark-label">
                        {fmtClock(splitSeedMin)}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
            {splitMenu && onSplit && (
              <div
                className="vt-split-menu"
                role="menu"
                aria-label="Split entry"
                style={{ top: `${splitMenu.topPx}px` }}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="vt-split-item"
                  ref={splitItemRef}
                  onClick={() => {
                    onSplit(splitMenu.entry, splitMenu.splitMin);
                    setSplitMenu(null);
                  }}
                >
                  <Icon name="scissors" size={12} /> Split at{" "}
                  {fmtClock(splitMenu.splitMin)}
                </button>
              </div>
            )}
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
    </div>
  );
}
