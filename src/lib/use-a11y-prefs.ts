import { useCallback, useEffect, useState } from "react";
import type {
  A11yPrefs,
  AmbiguityBehavior,
  DetectionPrompts,
  TextScale,
} from "./types";
import { coerceAmbiguity } from "./use-rules";

const STORAGE_KEY = "cairn:a11y-prefs:v1";

const DEFAULTS: A11yPrefs = {
  theme: "system",
  textScale: "md",
  highContrast: false,
  reduceMotion: matchesReduceMotion(),
  colorblindSafe: false,
  announce: true,
  alwaysFocusRing: false,
  detectionPrompts: "subtle",
  ambiguityDefault: "prompt",
};

function matchesReduceMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function load(): A11yPrefs {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<A11yPrefs>;
    // Coerce `ambiguityDefault` at the input boundary so a tampered
    // localStorage blob (`"yes"`, arrays, null) can't smuggle an
    // out-of-range value into `blankRule()` via `useRules`. Mirrors
    // the same guard the body deserializer uses on round-trip
    // (issue #16, security-review on #71).
    return {
      ...DEFAULTS,
      ...parsed,
      ambiguityDefault: coerceAmbiguity(parsed?.ambiguityDefault),
    };
  } catch {
    return DEFAULTS;
  }
}

export interface UseA11yPrefs extends A11yPrefs {
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
  const [prefs, setPrefs] = useState<A11yPrefs>(load);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      /* ignore quota errors */
    }
    const root = document.documentElement;
    root.dataset.textScale = prefs.textScale;
    root.dataset.highContrast = prefs.highContrast ? "on" : "off";
    root.dataset.reduceMotion = prefs.reduceMotion ? "on" : "off";
    root.dataset.colorblind = prefs.colorblindSafe ? "on" : "off";
    root.dataset.focusRing = prefs.alwaysFocusRing ? "always" : "kbd";
    root.dataset.detectionPrompts = prefs.detectionPrompts;
  }, [prefs]);

  const patch = useCallback(
    <K extends keyof A11yPrefs>(key: K, value: A11yPrefs[K]) =>
      setPrefs((p) => ({ ...p, [key]: value })),
    [],
  );

  return {
    ...prefs,
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
