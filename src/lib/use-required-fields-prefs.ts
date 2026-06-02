import { useCallback, useState } from "react";
import {
  REQUIRED_FIELDS_OFF,
  type RequiredFieldsPrefs,
} from "./required-fields";

const STORAGE_KEY = "cairn:required-fields:v1";

function read(): RequiredFieldsPrefs {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return REQUIRED_FIELDS_OFF;
    const parsed = JSON.parse(raw) as Partial<RequiredFieldsPrefs>;
    return {
      requireProject: parsed.requireProject === true,
      requireDescription: parsed.requireDescription === true,
    };
  } catch {
    return REQUIRED_FIELDS_OFF;
  }
}

export interface UseRequiredFieldsPrefs {
  prefs: RequiredFieldsPrefs;
  setRequireProject: (next: boolean) => void;
  setRequireDescription: (next: boolean) => void;
}

/**
 * Persisted required-fields-on-stop preference (#108). Both default OFF —
 * Cairn must not get in the way unasked. localStorage-backed, same
 * read-modify-write-against-state pattern as {@link useWorkingHours} so
 * an in-memory change survives a failed write in private mode.
 */
export function useRequiredFieldsPrefs(): UseRequiredFieldsPrefs {
  const [prefs, setPrefs] = useState<RequiredFieldsPrefs>(() => read());

  const update = useCallback((patch: Partial<RequiredFieldsPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      try {
        window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* private mode — preference just won't persist */
      }
      return next;
    });
  }, []);

  const setRequireProject = useCallback(
    (next: boolean) => update({ requireProject: next }),
    [update],
  );
  const setRequireDescription = useCallback(
    (next: boolean) => update({ requireDescription: next }),
    [update],
  );

  return { prefs, setRequireProject, setRequireDescription };
}
