import { useCallback, useState } from "react";

export type TodayEntriesView = "list" | "timeline" | "activity";

const STORAGE_KEY = "cairn:today-entries-view:v1";

function read(): TodayEntriesView {
  try {
    const v = window.localStorage?.getItem(STORAGE_KEY);
    if (v === "timeline" || v === "activity") return v;
    return "list";
  } catch {
    return "list";
  }
}

export interface UseTimelineViewPrefs {
  view: TodayEntriesView;
  setView: (view: TodayEntriesView) => void;
}

/**
 * Persisted choice of how the Today entries surface renders: the default flat
 * "list", the vertical "timeline" (#188), or the recorded-"activity" review
 * (#190; only offered while the activity log is on). List is the default.
 */
export function useTimelineViewPrefs(): UseTimelineViewPrefs {
  const [view, setViewState] = useState<TodayEntriesView>(() => read());

  const setView = useCallback((next: TodayEntriesView) => {
    setViewState(next);
    try {
      window.localStorage?.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode — preference won't persist */
    }
  }, []);

  return { view, setView };
}
