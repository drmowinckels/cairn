import { useCallback, useEffect, useState } from "react";
import { listConnectors, setConnectorEnabled, type Connector } from "./ipc";

export interface ConnectorsState {
  /** Loaded connectors, or `[]` while loading / outside Tauri. */
  connectors: Connector[];
  /** The initial load has resolved. */
  ready: boolean;
  /** Load/toggle error, or null. */
  error: string | null;
  /** The id of the connector whose enable toggle is in flight, or null. */
  busyId: string | null;
  /** Replace the list — used after a set/clear-token command, which returns
   *  the refreshed connectors, so the card reflects the new secret state. */
  replace: (next: Connector[]) => void;
  /** Enable/disable a connector. Optimistic (the switch flips immediately)
   *  and reverts if the backend rejects, so the UI never lies. */
  toggleEnabled: (id: string, next: boolean) => Promise<void>;
}

/** Loads the PM-connector list and toggles a connector's enabled state.
 *  Setting/clearing a token replaces the list in place via `replace`. */
export function useConnectors(): ConnectorsState {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await listConnectors();
        if (!cancelled) setConnectors(list);
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

  const toggleEnabled = useCallback(async (id: string, next: boolean) => {
    setBusyId(id);
    setError(null);
    setConnectors((cur) =>
      cur.map((c) => (c.id === id ? { ...c, enabled: next } : c)),
    );
    try {
      const updated = await setConnectorEnabled(id, next);
      // `setConnectorEnabled` returns `[]` outside Tauri — keep the optimistic
      // state in that case rather than blanking the list.
      if (updated.length > 0) setConnectors(updated);
    } catch (e) {
      setError(String(e));
      setConnectors((cur) =>
        cur.map((c) => (c.id === id ? { ...c, enabled: !next } : c)),
      );
    } finally {
      setBusyId(null);
    }
  }, []);

  return {
    connectors,
    ready,
    error,
    busyId,
    replace: setConnectors,
    toggleEnabled,
  };
}
