import { useCallback, useEffect, useState } from "react";
import { inTauri } from "./ipc";

export interface AutostartState {
  /** Whether the login item / startup entry is currently registered. */
  enabled: boolean;
  /** A toggle is in flight. */
  busy: boolean;
  /** Last error from enable/disable/probe, or null. */
  error: string | null;
  /** The initial probe has resolved (controls disabling the switch). */
  ready: boolean;
  toggle: (next: boolean) => Promise<void>;
}

/** Wraps `tauri-plugin-autostart` (cross-platform: macOS login item,
 *  Windows startup registry key, Linux `.desktop` autostart entry).
 *  Outside Tauri the plugin import is skipped and state is tracked
 *  in-memory so the UI still renders and toggles in tests / the browser
 *  dev harness. */
export function useAutostart(): AutostartState {
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!inTauri) {
      setReady(true);
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      try {
        const mod = await import("@tauri-apps/plugin-autostart");
        if (cancelled) return;
        // Coerce to a real boolean: a stubbed/absent plugin command can
        // resolve `undefined`, which would otherwise make the consuming
        // `aria-checked={enabled}` drop the attribute entirely.
        setEnabled((await mod.isEnabled()) === true);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = useCallback(async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (inTauri) {
        const mod = await import("@tauri-apps/plugin-autostart");
        if (next) await mod.enable();
        else await mod.disable();
      }
      setEnabled(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  return { enabled, busy, error, ready, toggle };
}
