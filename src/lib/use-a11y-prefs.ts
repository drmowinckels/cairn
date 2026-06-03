import { useCallback, useEffect, useState } from "react";
import type {
  A11yPrefs,
  AmbiguityBehavior,
  DetectionPrompts,
  TextScale,
  ThemePref,
} from "./types";
import {
  A11Y_STORAGE_KEY,
  applyA11yChrome,
  loadA11yPrefs,
} from "./use-apply-a11y-chrome";

export interface UseA11yPrefs extends A11yPrefs {
  setTheme: (v: ThemePref) => void;
  setTextScale: (v: TextScale) => void;
  setHighContrast: (v: boolean) => void;
  setReduceMotion: (v: boolean) => void;
  setColorblindSafe: (v: boolean) => void;
  setAnnounce: (v: boolean) => void;
  setAlwaysFocusRing: (v: boolean) => void;
  setDetectionPrompts: (v: DetectionPrompts) => void;
  setAmbiguityDefault: (v: AmbiguityBehavior) => void;
}

export function useA11yPrefs(): UseA11yPrefs {
  const [prefs, setPrefs] = useState<A11yPrefs>(loadA11yPrefs);

  useEffect(() => {
    try {
      window.localStorage.setItem(A11Y_STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      /* ignore quota errors */
    }
    return applyA11yChrome(prefs);
  }, [prefs]);

  const patch = useCallback(
    <K extends keyof A11yPrefs>(key: K, value: A11yPrefs[K]) =>
      setPrefs((p) => ({ ...p, [key]: value })),
    [],
  );

  return {
    ...prefs,
    setTheme: (v) => patch("theme", v),
    setTextScale: (v) => patch("textScale", v),
    setHighContrast: (v) => patch("highContrast", v),
    setReduceMotion: (v) => patch("reduceMotion", v),
    setColorblindSafe: (v) => patch("colorblindSafe", v),
    setAnnounce: (v) => patch("announce", v),
    setAlwaysFocusRing: (v) => patch("alwaysFocusRing", v),
    setDetectionPrompts: (v) => patch("detectionPrompts", v),
    setAmbiguityDefault: (v) => patch("ambiguityDefault", v),
  };
}
