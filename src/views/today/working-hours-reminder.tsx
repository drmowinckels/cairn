import { Icon } from "../../lib/icon";
import type { DetectionPrompts } from "../../lib/types";

interface Props {
  /** Reuses the detection-prompt presentation setting (subtle/modal). */
  style: Exclude<DetectionPrompts, "off">;
  announce: boolean;
  onStart: () => void;
  onDismiss: () => void;
}

/**
 * The #99 working-hours reminder: a subtle, non-modal prompt shown when the
 * user is idle during their configured hours with no timer running. It only
 * *offers* to start tracking — tapping "Start tracking" begins a blank timer
 * the user then fills in; it never auto-logs. Mirrors the detection
 * suggestion banner's styling so it inherits the reduced-motion handling.
 */
export function WorkingHoursReminder({
  style,
  announce,
  onStart,
  onDismiss,
}: Props) {
  return (
    <section
      className={`suggest suggest--${style}`}
      aria-label="Start tracking reminder"
      // Inline notification, not a dialog — announce via the live region
      // (assertive for "modal", polite otherwise); see today.tsx.
      aria-live={
        announce ? (style === "modal" ? "assertive" : "polite") : "off"
      }
    >
      <div className="suggest-head">
        <Icon name="moon" size={13} />
        <span>Not tracking</span>
        <button
          className="suggest-x"
          onClick={onDismiss}
          aria-label="Dismiss reminder"
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className="suggest-body">
        You've been idle during your working hours. Start tracking your time?
      </div>
      <div className="suggest-actions">
        <button className="btn btn--primary" onClick={onStart}>
          <Icon name="play" size={13} /> Start tracking
        </button>
        <button className="btn btn--ghost" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </section>
  );
}
