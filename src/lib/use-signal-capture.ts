import { useCallback, useEffect, useState } from "react";
import {
  signalCaptureStatus,
  startSignalCapture,
  stopSignalCapture,
  type SignalCaptureStatus,
} from "./ipc";

const POLL_MS = 1000;
const INACTIVE: SignalCaptureStatus = {
  active: false,
  path: null,
  bytesWritten: 0,
};

export interface UseSignalCapture {
  status: SignalCaptureStatus;
  error: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * Debug "Capture raw signals" hook. The state is owned by the backend
 * (`signals::capture::SignalCapture`); this hook polls it once a second
 * so the footer banner and the Settings → Advanced toggle stay
 * synchronized even if some other window flipped the toggle.
 *
 * Polling errors are swallowed so a transient IPC blip doesn't flicker
 * the footer banner off. `start()` / `stop()` errors surface in
 * `error` so the Settings dialog can render them.
 */
export function useSignalCapture(): UseSignalCapture {
  const [status, setStatus] = useState<SignalCaptureStatus>(INACTIVE);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await signalCaptureStatus();
      setStatus(next);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await signalCaptureStatus();
        if (!cancelled) setStatus(next);
      } catch {
        /* see hook docs */
      }
    };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      const path = await startSignalCapture();
      setStatus({ active: true, path, bytesWritten: 0 });
    } catch (e) {
      setError(String(e));
      throw e;
    }
  }, []);

  const stop = useCallback(async () => {
    setError(null);
    try {
      await stopSignalCapture();
      setStatus(INACTIVE);
    } catch (e) {
      setError(String(e));
      throw e;
    }
  }, []);

  return { status, error, start, stop, refresh };
}
