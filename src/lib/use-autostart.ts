import { useCallback, useEffect, useState } from "react";
import { autostartEnabled, setAutostart } from "./ipc";

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

/** Drives launch-at-login (macOS login item, Windows startup key, Linux
 *  `.desktop` entry) through the backend `autostart_enabled` /
 *  `set_autostart` commands. The backend gates `set_autostart`, refusing to
 *  register a dev/unpackaged build (#261); a refused enable rejects with a
 *  message that lands in `error` and leaves the switch off. Outside Tauri
 *  the commands echo state in-memory so the UI still renders and toggles in
 *  tests / the browser dev harness. */
export function useAutostart(): AutostartState {
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const on = await autostartEnabled();
        if (!cancelled) setEnabled(on === true);
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
      // Reflect exactly what the backend reports: a refused enable (dev
      // build) rejects, so we surface the error and leave `enabled` as-is
      // rather than flipping the switch on a registration that didn't happen.
      setEnabled((await setAutostart(next)) === true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  return { enabled, busy, error, ready, toggle };
}
