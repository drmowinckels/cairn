import { useEffect, useState } from "react";
import { listConnectors, type Connector } from "./ipc";

export interface ConnectorsState {
  /** Loaded connectors, or `[]` while loading / outside Tauri. */
  connectors: Connector[];
  /** The initial load has resolved. */
  ready: boolean;
  /** Load error, or null. */
  error: string | null;
  /** Replace the list — used after a set/clear-token command, which returns
   *  the refreshed connectors, so the card reflects the new secret state. */
  replace: (next: Connector[]) => void;
}

/** Loads the PM-connector list once (read-only browsing; setting/clearing a
 *  connector's token updates the list in place via `replace`). */
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

  return { connectors, ready, error, replace: setConnectors };
}
