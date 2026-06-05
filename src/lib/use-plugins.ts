import { useCallback, useEffect, useState } from "react";
import { listPlugins, setPluginEnabled, type Plugin } from "./ipc";

export interface PluginsState {
  /** Registered signal-source plugins, or `[]` while loading / outside Tauri. */
  plugins: Plugin[];
  /** The initial load has resolved. */
  ready: boolean;
  /** The id of the plugin whose toggle is in flight, or null. */
  busyId: string | null;
  /** Last toggle error, or null. */
  error: string | null;
  toggle: (id: string, next: boolean) => Promise<void>;
}

/** Loads the plugin list and toggles a plugin's enabled state. The
 *  toggle is optimistic (the switch flips immediately) and reverts if
 *  the backend rejects, so the UI never lies about a failed write. */
export function usePlugins(): PluginsState {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [ready, setReady] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await listPlugins();
        if (!cancelled) setPlugins(list);
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

  const toggle = useCallback(async (id: string, next: boolean) => {
    setBusyId(id);
    setError(null);
    setPlugins((cur) =>
      cur.map((p) => (p.id === id ? { ...p, enabled: next } : p)),
    );
    try {
      const updated = await setPluginEnabled(id, next);
      // `setPluginEnabled` returns `[]` outside Tauri — keep the
      // optimistic state in that case rather than blanking the list.
      if (updated.length > 0) setPlugins(updated);
    } catch (e) {
      setError(String(e));
      setPlugins((cur) =>
        cur.map((p) => (p.id === id ? { ...p, enabled: !next } : p)),
      );
    } finally {
      setBusyId(null);
    }
  }, []);

  return { plugins, ready, busyId, error, toggle };
}
