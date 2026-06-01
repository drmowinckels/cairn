import { useCallback, useState } from "react";

export type DataViewMode = "sections" | "tree";

const STORAGE_KEY = "cairn:data-view:v1";

function read(): DataViewMode {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (raw === "tree") return "tree";
    return "sections";
  } catch {
    return "sections";
  }
}

export interface UseDataViewPrefs {
  mode: DataViewMode;
  setMode: (mode: DataViewMode) => void;
}

export function useDataViewPrefs(): UseDataViewPrefs {
  const [mode, setModeState] = useState<DataViewMode>(() => read());

  const setMode = useCallback((next: DataViewMode) => {
    setModeState(next);
    try {
      window.localStorage?.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode — preference won't persist */
    }
  }, []);

  return { mode, setMode };
}
