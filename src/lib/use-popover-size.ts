import { useCallback, useEffect, useState } from "react";
import { inTauri, setPopoverSize } from "./ipc";

export type PopoverSize = "compact" | "large";

const STORAGE_KEY = "cairn:popover-size:v1";

/** Logical width/height for each preset. Compact matches the
 *  tauri.conf default; large gives the timeline/reports more room
 *  without abandoning the anchored tray-card model (issue #1). */
export const POPOVER_DIMENSIONS: Record<
  PopoverSize,
  { width: number; height: number }
> = {
  compact: { width: 560, height: 760 },
  large: { width: 680, height: 900 },
};

export interface UsePopoverSize {
  size: PopoverSize;
  setSize: (next: PopoverSize) => void;
}

function readStored(): PopoverSize {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    return raw === "large" ? "large" : "compact";
  } catch {
    return "compact";
  }
}

function applySize(size: PopoverSize) {
  const { width, height } = POPOVER_DIMENSIONS[size];
  void setPopoverSize(width, height).catch((e) =>
    console.warn("set_popover_size failed", e),
  );
}

/**
 * Persisted popover-size preset (issue #1). Mount once at the popover
 * root: it applies the stored preset to the real window on load (so a
 * previously-chosen "large" reopens large) and exposes a setter the
 * Settings control drives. A no-op outside Tauri.
 */
export function usePopoverSize(): UsePopoverSize {
  const [size, setSizeState] = useState<PopoverSize>(() => readStored());

  useEffect(() => {
    // Reflect the preset on the root dataset for any styling/tests.
    // Do NOT resize the window here: the window is freely resizable and
    // its geometry is restored from tauri-plugin-window-state on launch
    // (#100); applying on mount would clobber the user's saved size.
    try {
      document.documentElement.dataset.popoverSize = size;
    } catch {
      /* no document (non-DOM test env) — skip */
    }
  }, [size]);

  const setSize = useCallback((next: PopoverSize) => {
    setSizeState(next);
    try {
      window.localStorage?.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode / no storage — preset just won't persist */
    }
    // Quick-resize on an explicit choice only; window-state then
    // persists whatever the user lands on.
    if (inTauri) applySize(next);
  }, []);

  return { size, setSize };
}
