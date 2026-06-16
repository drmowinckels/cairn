import { useCallback, useState } from "react";

export type TodayEntriesView = "list" | "timeline";

const STORAGE_KEY = "cairn:today-entries-view:v1";

function read(): TodayEntriesView {
  try {
    return window.localStorage?.getItem(STORAGE_KEY) === "timeline"
      ? "timeline"
      : "list";
  } catch {
    return "list";
  }
}

export interface UseTimelineViewPrefs {
  view: TodayEntriesView;
  setView: (view: TodayEntriesView) => void;
}

/**
 * Persisted choice of how the Today entries surface renders (#188): the
 * default flat "list" or the vertical "timeline". List is the default so the
 * timeline stays opt-in.
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
