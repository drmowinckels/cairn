import { useCallback, useEffect, useState } from "react";
import {
  deleteExclusion,
  inTauri,
  listExclusions,
  saveExclusion,
  type BackendExclusion,
  type ExclusionKind,
} from "./ipc";

export interface UseExclusions {
  exclusions: BackendExclusion[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  add: (kind: ExclusionKind, value: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export function useExclusions(): UseExclusions {
  const [exclusions, setExclusions] = useState<BackendExclusion[]>([]);
  const [loading, setLoading] = useState(inTauri);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!inTauri) return;
    try {
      setExclusions((await listExclusions()) ?? []);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const add = useCallback(
    async (kind: ExclusionKind, value: string) => {
      await saveExclusion(kind, value);
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await deleteExclusion(id);
      await refresh();
    },
    [refresh],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { exclusions, loading, error, refresh, add, remove };
}

/**
 * Infer the exclusion kind from a raw input string. A value with
 * whitespace reads as a window-title pattern; a dotted/`*.`-prefixed
 * token reads as a domain; everything else is an app name. The backend
 * is the source of truth for the kind enum — this is just a sensible
 * default so the user rarely has to think about it.
 */
export function guessExclusionKind(raw: string): ExclusionKind {
  const t = raw.trim();
  if (/\s/.test(t)) return "window";
  if (t.startsWith("*.") || t.includes(".")) return "domain";
  return "app";
}
