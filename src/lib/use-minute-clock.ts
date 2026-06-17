import { useEffect, useState } from "react";

/** Minute-of-day (0–1440, with fractional seconds) right now. */
export function minutesNow(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

/**
 * The shared 60-second clock for the timeline views (#188). Returns the
 * current minute-of-day and re-renders once a minute, so the running entry and
 * the "now" rule advance without each timeline owning its own interval.
 */
export function useMinuteClock(): number {
  const [nowMin, setNowMin] = useState(() => minutesNow());
  useEffect(() => {
    const id = window.setInterval(() => setNowMin(minutesNow()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return nowMin;
}
