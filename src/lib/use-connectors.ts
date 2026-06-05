import { useEffect, useState } from "react";
import { listConnectors, type Connector } from "./ipc";

export interface ConnectorsState {
  /** Loaded connectors, or `[]` while loading / outside Tauri. */
  connectors: Connector[];
  /** The initial load has resolved. */
  ready: boolean;
  /** Load error, or null. */
  error: string | null;
}

/** Loads the PM-connector list once (read-only this session — per-connector
 *  enable/disable + import land with a later slice). */
export function useConnectors(): ConnectorsState {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return { connectors, ready, error };
}
