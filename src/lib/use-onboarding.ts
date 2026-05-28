import { useCallback, useEffect, useState } from "react";
import {
  completeOnboarding as completeOnboardingIpc,
  getOnboardingState,
  resetOnboarding as resetOnboardingIpc,
  type OnboardingState,
} from "./ipc";

export type OnboardingStatus = "loading" | "needs-onboarding" | "completed";

export interface UseOnboarding {
  status: OnboardingStatus;
  state: OnboardingState | null;
  complete: () => Promise<void>;
  reset: () => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * Mirror of the Rust `app_state` row that drives the first-run
 * onboarding overlay (issue #31). The popover renders onboarding
 * when `status === "needs-onboarding"`; Settings exposes `reset()`
 * as "Run onboarding again" to re-arm the flow.
 *
 * Outside Tauri (`inTauri === false`) the IPC layer returns an
 * already-completed state so Vite/vitest doesn't trap the developer
 * in the overlay on every reload; we still surface a `loading`
 * state on first render to let consumers branch on it.
 */
export function useOnboarding(): UseOnboarding {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [status, setStatus] = useState<OnboardingStatus>("loading");

  const refresh = useCallback(async () => {
    try {
      const next = await getOnboardingState();
      setState(next);
      setStatus(next.completedAt === null ? "needs-onboarding" : "completed");
    } catch {
      // A failed read defaults to "completed" so a transient backend
      // hiccup doesn't trap an existing user in onboarding.
      setState({ completedAt: new Date(0).toISOString() });
      setStatus("completed");
    }
  }, []);

  const complete = useCallback(async () => {
    const next = await completeOnboardingIpc();
    setState(next);
    setStatus(next.completedAt === null ? "needs-onboarding" : "completed");
  }, []);

  const reset = useCallback(async () => {
    const next = await resetOnboardingIpc();
    setState(next);
    setStatus(next.completedAt === null ? "needs-onboarding" : "completed");
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { status, state, complete, reset, refresh };
}
