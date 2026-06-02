import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Global ⌘K / Ctrl+K listener + open/close state for the command
 * palette (#32). Mount once at the popover root. Returns
 * `{ open, requestOpen, close }`. The hook is intentionally minimal:
 * it doesn't own the command list (that's `palette.tsx`), and it
 * doesn't read MRU storage (that's `mruStore`) so each concern can
 * be unit-tested on its own.
 */
export interface UsePalette {
  open: boolean;
  /**
   * Programmatically open the palette (e.g. from the header's
   * search icon). Captures the current `activeElement` so it can be
   * restored on close.
   */
  requestOpen: () => void;
  /**
   * Close the palette. Restores focus to the element that was
   * focused at `requestOpen` time, when that element is still in
   * the DOM and focusable.
   */
  close: () => void;
}

export interface UsePaletteOpts {
  /** Override for tests. Defaults to `window`. */
  target?: Window | HTMLElement;
  /**
   * Called whenever the palette transitions open → true. Used by
   * `popover.tsx` to close the project-picker so the two overlays
   * never coexist (acceptance criterion).
   */
  onOpen?: () => void;
}

export function usePalette(opts: UsePaletteOpts = {}): UsePalette {
  const [open, setOpen] = useState(false);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const onOpen = opts.onOpen;

  const requestOpen = useCallback(() => {
    const active = (document.activeElement as HTMLElement | null) ?? null;
    setOpener(active);
    setOpen(true);
    onOpen?.();
  }, [onOpen]);

  const close = useCallback(() => {
    setOpen(false);
    // Defer to next frame so React tears down the dialog first;
    // focusing a removed element is a silent no-op.
    if (opener && typeof opener.focus === "function") {
      window.requestAnimationFrame(() => {
        opener.focus();
      });
    }
  }, [opener]);

  useEffect(() => {
    const target = opts.target ?? window;
    const handler = (e: Event) => {
      const ke = e as KeyboardEvent;
      // Match ⌘K on macOS and Ctrl+K everywhere else. We accept
      // either modifier so a Mac user with an external PC keyboard
      // still triggers the palette.
      if (ke.key !== "k" && ke.key !== "K") return;
      if (!(ke.metaKey || ke.ctrlKey)) return;
      ke.preventDefault();
      // Toggle: a second ⌘K closes the palette.
      if (open) {
        // Re-use `close()` so opener focus is restored on toggle-off.
        setOpen(false);
        if (opener && typeof opener.focus === "function") {
          window.requestAnimationFrame(() => {
            opener.focus();
          });
        }
        return;
      }
      const active = (document.activeElement as HTMLElement | null) ?? null;
      setOpener(active);
      setOpen(true);
      onOpen?.();
    };
    target.addEventListener("keydown", handler as EventListener);
    return () =>
      target.removeEventListener("keydown", handler as EventListener);
  }, [open, opener, opts.target, onOpen]);

  return useMemo(
    () => ({ open, requestOpen, close }),
    [open, requestOpen, close],
  );
}

// ────────────────────────────────────────────────────────────────────
// MRU store — recently-used command ids, persisted to localStorage.
// Capped at MRU_MAX. Exported so palette.tsx + tests share one impl.
// ────────────────────────────────────────────────────────────────────

export const MRU_KEY = "cairn.palette.mru.v1";
export const MRU_MAX = 50;

export interface MruStore {
  read: () => string[];
  bump: (id: string) => void;
  clear: () => void;
}

/**
 * Build an MRU store backed by `storage` (default: `localStorage`).
 * The backing store is read on every call so two tabs sharing a
 * profile see each other's writes immediately on the next palette
 * open — matches the user expectation that MRU is global, not
 * per-instance.
 */
export function createMruStore(storage?: Storage | null): MruStore {
  // Fall back to a no-op store when localStorage is unavailable
  // (Tauri popover with no persistence layer, or test env with
  // happy-dom storage stubbed out). The palette still works; the
  // ranking simply ignores recency. `null` is explicit "no-op";
  // `undefined` falls back to window.localStorage.
  const safe = storage === undefined ? safeLocalStorage() : storage;
  return {
    read: () => readMru(safe),
    bump: (id) => bumpMru(safe, id),
    clear: () => {
      if (safe) safe.removeItem(MRU_KEY);
    },
  };
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function readMru(storage: Storage | null): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(MRU_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

function bumpMru(storage: Storage | null, id: string): void {
  if (!storage) return;
  const current = readMru(storage);
  const next = [id, ...current.filter((x) => x !== id)].slice(0, MRU_MAX);
  try {
    storage.setItem(MRU_KEY, JSON.stringify(next));
  } catch {
    // Storage quota exceeded or disabled — drop silently. The
    // palette degrades to "no MRU" rather than crashing the popover.
  }
}

/**
 * Compose a list of command ids with the MRU order pinned to the
 * front, preserving relative order of the rest. Used by palette.tsx
 * when the query is empty so frequently-used commands surface first.
 * Exported so tests can pin the contract.
 */
export function applyMruOrder<T>(
  items: T[],
  idOf: (item: T) => string,
  mru: string[],
): T[] {
  if (mru.length === 0) return items.slice();
  const byId = new Map<string, T>();
  for (const item of items) byId.set(idOf(item), item);
  const out: T[] = [];
  const seen = new Set<string>();
  for (const id of mru) {
    const it = byId.get(id);
    if (!it) continue;
    out.push(it);
    seen.add(id);
  }
  for (const item of items) {
    if (!seen.has(idOf(item))) out.push(item);
  }
  return out;
}
