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
    // Drive the card width via a root dataset attr (same pattern as the
    // a11y prefs) so the preset is visible in browser-dev too, and
    // resize the real OS window when running under Tauri.
    try {
      document.documentElement.dataset.popoverSize = size;
    } catch {
      /* no document (non-DOM test env) — skip */
    }
    if (inTauri) applySize(size);
    // Only re-apply when the stored preset changes, not every render.
  }, [size]);

  const setSize = useCallback((next: PopoverSize) => {
    setSizeState(next);
    try {
      window.localStorage?.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode / no storage — preset just won't persist */
    }
  }, []);

  return { size, setSize };
}
