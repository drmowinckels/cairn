import { useCallback, useSyncExternalStore } from "react";
import {
  coerceFormatPrefs,
  DATETIME_FORMAT_DEFAULT,
  type DateFormat,
  type DateTimeFormatPrefs,
  type TimeFormat,
} from "./datetime-format";

export const DATETIME_FORMAT_STORAGE_KEY = "cairn:datetime-format:v1";

/**
 * Module-level store for the date/time format preference (#308).
 *
 * A store rather than the `useState`-per-hook pattern the other preferences
 * use, for two reasons specific to this one:
 *
 * 1. Formatting happens in leaf components all over the tree (timeline ticks,
 *    entry rows, the idle prompt). A single source every one of them reads
 *    beats threading the preference through, and beats each call site owning
 *    its own `useState` copy that the others can't see.
 * 2. Cairn runs several webviews (popover, idle, notify, about) against one
 *    origin. They share `localStorage`, so a change made in Settings reaches
 *    the others through the `storage` event — which only fires cross-document,
 *    hence the explicit same-document notify in {@link setDateTimeFormatPrefs}.
 */

let current: DateTimeFormatPrefs = readStored();
const listeners = new Set<() => void>();

function readStored(): DateTimeFormatPrefs {
  try {
    const raw = window.localStorage?.getItem(DATETIME_FORMAT_STORAGE_KEY);
    if (!raw) return DATETIME_FORMAT_DEFAULT;
    return coerceFormatPrefs(JSON.parse(raw));
  } catch {
    // Unavailable (private mode) or corrupt JSON — the default is always a
    // valid answer, so never let a bad blob stop the app rendering times.
    return DATETIME_FORMAT_DEFAULT;
  }
}

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current preference, for the non-React callers in `lib/time.ts`. */
export function dateTimeFormatPrefs(): DateTimeFormatPrefs {
  return current;
}

/** Replace the preference, persist it, and notify this document's readers. */
export function setDateTimeFormatPrefs(next: DateTimeFormatPrefs): void {
  current = coerceFormatPrefs(next);
  try {
    window.localStorage?.setItem(
      DATETIME_FORMAT_STORAGE_KEY,
      JSON.stringify(current),
    );
  } catch {
    /* private mode — the change applies now but won't outlive the session */
  }
  emit();
}

/**
 * Re-read the stored preference and notify if it changed. Called on the
 * `storage` event so a change made in the popover's Settings repaints the
 * idle prompt's clock without either window reloading.
 */
export function syncDateTimeFormatPrefs(): void {
  const next = readStored();
  if (next.time === current.time && next.date === current.date) return;
  current = next;
  emit();
}

/** Handle a `storage` event: re-read when it concerns this key, or when the
 *  whole store was cleared (`key === null`). */
function onStorage(e: Event): void {
  const { key } = e as StorageEvent;
  if (key === null || key === DATETIME_FORMAT_STORAGE_KEY) {
    syncDateTimeFormatPrefs();
  }
}

/**
 * Subscribe to cross-window preference changes. Exported (and parameterised)
 * so both outcomes are exercised: a webview, and an environment with no
 * `window` at all — which is the only reason the guard exists.
 */
export function installStorageSync(
  target: Pick<Window, "addEventListener"> | undefined = globalThis.window,
): void {
  target?.addEventListener("storage", onStorage);
}

installStorageSync();

/** Test-only: reset the store to defaults without touching `localStorage`. */
export function resetDateTimeFormatPrefsForTest(
  prefs: DateTimeFormatPrefs = DATETIME_FORMAT_DEFAULT,
): void {
  current = prefs;
  emit();
}

/**
 * Re-render this component when the date/time format preference changes,
 * without reading it.
 *
 * For components that format through the module-level helpers in `lib/time.ts`
 * (`fmtClock`, `fmtClockFromIso`). Those read the preference imperatively, so
 * a component that never subscribes would keep showing the old clock until
 * something else re-rendered it. Any component rendering a time of day should
 * call this.
 */
export function useDateTimeFormatSubscription(): void {
  useSyncExternalStore(subscribe, dateTimeFormatPrefs);
}

export interface UseDateTimeFormat {
  prefs: DateTimeFormatPrefs;
  setTimeFormat: (next: TimeFormat) => void;
  setDateFormat: (next: DateFormat) => void;
}

/**
 * Subscribe to the date/time format preference. Every consumer re-renders
 * when it changes, so a switch in Settings updates the timeline, entry rows
 * and running-timer clock immediately rather than on next mount.
 */
export function useDateTimeFormat(): UseDateTimeFormat {
  const prefs = useSyncExternalStore(subscribe, dateTimeFormatPrefs);

  const setTimeFormat = useCallback(
    (time: TimeFormat) => setDateTimeFormatPrefs({ ...current, time }),
    [],
  );
  const setDateFormat = useCallback(
    (date: DateFormat) => setDateTimeFormatPrefs({ ...current, date }),
    [],
  );

  return { prefs, setTimeFormat, setDateFormat };
}
