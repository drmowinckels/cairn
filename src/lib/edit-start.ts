/**
 * Pure validation for editing a running timer's start time (the "I forgot to
 * start it" fix). The user types into a `datetime-local` input (local wall
 * clock, no zone); we accept it only if it parses and isn't in the future —
 * you can't have started a session that hasn't happened yet. `nowMs` is
 * injected so the check is testable without a real clock.
 */

export type StartEditResult =
  | { ok: true; iso: string }
  | { ok: false; reason: "empty" | "invalid" | "future" };

export function validateStartEdit(
  local: string,
  nowMs: number,
): StartEditResult {
  if (!local) return { ok: false, reason: "empty" };
  // `datetime-local` strings ("YYYY-MM-DDTHH:MM") are parsed in the local
  // zone, matching how the value was entered.
  const ms = Date.parse(local);
  if (Number.isNaN(ms)) return { ok: false, reason: "invalid" };
  if (ms > nowMs) return { ok: false, reason: "future" };
  return { ok: true, iso: new Date(ms).toISOString() };
}

/** Human-facing message for a rejected start edit. */
export function startEditError(reason: "empty" | "invalid" | "future"): string {
  return reason === "future"
    ? "Start can't be in the future."
    : "Enter a valid start time.";
}
