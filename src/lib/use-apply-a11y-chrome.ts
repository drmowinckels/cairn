import { useLayoutEffect } from "react";
import type { A11yPrefs, Theme, ThemePref } from "./types";
import { coerceAmbiguity } from "./use-rules";

export const A11Y_STORAGE_KEY = "cairn:a11y-prefs:v1";

export function matchesReduceMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export const A11Y_DEFAULTS: A11yPrefs = {
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

function darkSchemeQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || !window.matchMedia) return null;
  return window.matchMedia("(prefers-color-scheme: dark)");
}

/** Resolve a theme preference to the concrete theme to paint. "system"
 *  follows the OS via prefers-color-scheme; an explicit pref wins. */
export function resolveTheme(
  pref: ThemePref,
  mq: MediaQueryList | null,
): Theme {
  if (pref === "system") return mq?.matches ? "dark" : "light";
  return pref;
}

/** Read the persisted a11y prefs, merged over the defaults. Coerces
 *  `ambiguityDefault` at the boundary (issue #16, security-review on #71)
 *  and falls back to defaults on any parse failure. */
export function loadA11yPrefs(): A11yPrefs {
  if (typeof window === "undefined") return A11Y_DEFAULTS;
  try {
    const raw = window.localStorage.getItem(A11Y_STORAGE_KEY);
    if (!raw) return A11Y_DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<A11yPrefs>;
    return {
      ...A11Y_DEFAULTS,
      ...parsed,
      ambiguityDefault: coerceAmbiguity(parsed?.ambiguityDefault),
    };
  } catch {
    return A11Y_DEFAULTS;
  }
}

/** Paint the accessibility chrome (theme/scale/motion/contrast/colorblind/
 *  focus-ring/detection-prompts) onto `<html>` and keep "system" theme
 *  tracking the OS via `prefers-color-scheme`. Returns the listener
 *  cleanup so callers can run it inside an effect. */
export function applyA11yChrome(prefs: A11yPrefs): () => void {
  const root = document.documentElement;
  root.dataset.textScale = prefs.textScale;
  root.dataset.highContrast = prefs.highContrast ? "on" : "off";
  root.dataset.reduceMotion = prefs.reduceMotion ? "on" : "off";
  root.dataset.colorblind = prefs.colorblindSafe ? "on" : "off";
  root.dataset.focusRing = prefs.alwaysFocusRing ? "always" : "kbd";
  root.dataset.detectionPrompts = prefs.detectionPrompts;

  const mq = darkSchemeQuery();
  const applyTheme = () => {
    root.dataset.theme = resolveTheme(prefs.theme, mq);
  };
  applyTheme();
  if (prefs.theme === "system" && mq) {
    mq.addEventListener("change", applyTheme);
    return () => mq.removeEventListener("change", applyTheme);
  }
  return () => {};
}

/**
 * Read-only a11y chrome for satellite webviews (idle, About) that don't
 * own the settings state machine. Loads the persisted prefs from
 * localStorage on mount and paints them onto `<html>` before paint (so
 * there's no light-theme / full-motion flash), keeping "system" theme in
 * sync with the OS. The popover uses {@link useA11yPrefs} instead, which
 * re-applies on every settings change.
 */
export function useApplyA11yChrome(): void {
  useLayoutEffect(() => applyA11yChrome(loadA11yPrefs()), []);
}
