import { useCallback, useEffect, useRef } from "react";

/**
 * Returns a stable callback that batches rapid invocations and
 * fires the *last* one after `delay` ms of quiet time. Used by
 * the rule editor to avoid one save per keystroke (which would
 * spam SQLite writes + rules-cache reloads for every character
 * the user types).
 *
 * The returned callback also exposes `.flush()` so blur / unmount
 * can commit any pending invocation immediately.
 */
export interface DebouncedFn<A extends unknown[]> {
  (...args: A): void;
  flush: () => void;
  cancel: () => void;
}

export function useDebouncedCallback<A extends unknown[]>(
  fn: (...args: A) => void,
  delay: number,
): DebouncedFn<A> {
  const fnRef = useRef(fn);
  const argsRef = useRef<A | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the latest fn without re-creating the debounced callback;
  // otherwise every render would reset the pending timer.
  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  const fire = useCallback(() => {
    if (argsRef.current === null) return;
    const args = argsRef.current;
    argsRef.current = null;
    timerRef.current = null;
    fnRef.current(...args);
  }, []);

  const debounced = useCallback(
    (...args: A) => {
      argsRef.current = args;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(fire, delay);
    },
    [delay, fire],
  );

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    fire();
  }, [fire]);

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    argsRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const result = debounced as DebouncedFn<A>;
  result.flush = flush;
  result.cancel = cancel;
  return result;
}
