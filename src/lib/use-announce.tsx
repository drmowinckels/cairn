import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface AnnouncerCtx {
  announce: (message: string) => void;
  enabled: boolean;
}

const Ctx = createContext<AnnouncerCtx | null>(null);

interface ProviderProps {
  enabled: boolean;
  children: ReactNode;
}

/**
 * Mounts the central `<div role="status" aria-live="polite">` region
 * that every consumer (`useAnnounce`) writes to. Honors the user's
 * "Screen reader announcements" pref — when `enabled` is false, calls
 * to `announce()` are no-ops and the live region renders empty.
 *
 * Why a single shared region instead of per-component aria-live: AT
 * implementations differ in how they coalesce multiple live regions,
 * and quick state churn (timer ticks, suggestion appear/dismiss) can
 * flood NVDA with stale announcements. A single coalesced region with
 * a short flush window keeps the announcement queue predictable.
 */
export function AnnouncerProvider({ enabled, children }: ProviderProps) {
  const [message, setMessage] = useState("");
  const lastRef = useRef<string>("");
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      setMessage("");
      lastRef.current = "";
    }
  }, [enabled]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const announce = useCallback(
    (next: string) => {
      if (!enabled) return;
      if (!next) return;
      // Coalesce: a repeat of the previous announcement is dropped to
      // stop NVDA/JAWS from re-reading the same string on every render
      // (the timer tick is the worst offender).
      if (lastRef.current === next) return;
      lastRef.current = next;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
      // Clear-then-set forces ATs to treat the new message as a fresh
      // change even when the text matches a slightly older value that
      // was already cleared off the live region.
      setMessage("");
      timerRef.current = window.setTimeout(() => {
        setMessage(next);
        timerRef.current = null;
      }, 30);
    },
    [enabled],
  );

  const value = useMemo<AnnouncerCtx>(
    () => ({ announce, enabled }),
    [announce, enabled],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="cairn-announcer"
      >
        {message}
      </div>
    </Ctx.Provider>
  );
}

/**
 * Consumer hook. Components call `announce("Timer started")` and the
 * provider routes it to the shared live region. Returns a no-op when
 * called outside a provider so tests rendering a component in
 * isolation don't blow up.
 */
export function useAnnounce(): (message: string) => void {
  const ctx = useContext(Ctx);
  return ctx?.announce ?? noop;
}

function noop(): void {
  /* no-op when no provider is mounted */
}
