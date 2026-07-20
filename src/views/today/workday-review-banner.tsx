import { Icon } from "../../lib/icon";
import type { BannerStyle } from "./task-switch-banner";

interface Props {
  /** Presentation-only variant shared with the task-switch and
   *  working-hours banners — mapped from `DetectionPrompts` in the Today
   *  view (`"notification"` tier → the heavier `"modal"` CSS, see #267). */
  style: BannerStyle;
  announce: boolean;
  onReview: () => void;
  onDismiss: () => void;
}

/**
 * The "Workday in Review" banner: a subtle, non-modal prompt offered once
 * working hours end when there's unreviewed activity-log data for the day.
 * It only *points at* the existing Activity view — tapping "Review" never
 * assigns or discards anything on its own. Mirrors the working-hours
 * reminder's presentation so it inherits the reduced-motion handling.
 */
export function WorkdayReviewBanner({
  style,
  announce,
  onReview,
  onDismiss,
}: Props) {
  return (
    <section
      className={`suggest suggest--${style}`}
      aria-label="Workday review reminder"
      aria-live={
        announce ? (style === "modal" ? "assertive" : "polite") : "off"
      }
    >
      <div className="suggest-head">
        <Icon name="reports" size={13} />
        <span>Workday in review</span>
        <button
          className="suggest-x"
          onClick={onDismiss}
          aria-label="Dismiss workday review reminder"
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className="suggest-body">
        Your working hours ended and there's activity you haven't reviewed yet.
      </div>
      <div className="suggest-actions">
        <button className="btn btn--primary" onClick={onReview}>
          <Icon name="reports" size={13} /> Review
        </button>
        <button className="btn btn--ghost" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </section>
  );
}
