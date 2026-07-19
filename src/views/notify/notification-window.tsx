import { useEffect } from "react";
import { Icon } from "../../lib/icon";
import { ProjectChip, Tag } from "../../lib/components";
import { useApplyA11yChrome } from "../../lib/use-apply-a11y-chrome";
import { useNotificationWindow } from "../../lib/use-notification-window";
import { SuggestWhy } from "../today/suggest-why";

/**
 * The dedicated suggestion-notification window (#267). Rendered when the
 * app loads under `?win=notify`. Replaces the old "Modal" detection-prompt
 * tier's heavier CSS treatment of the inline `.suggest` banner with a real,
 * separate always-on-top window — so a match isn't lost while the user is
 * on another tab or the popover is hidden.
 *
 * Deliberately NOT a focus trap (unlike `IdleWindow`): the idle prompt is a
 * forced choice the user must resolve, but this is a dismissible proposal
 * ("suggestion ≠ auto-log") the user can simply ignore. Trapping focus on
 * something the user didn't ask to interact with would be a worse
 * interruption than the inline banner it replaces, and the backend
 * (`notification_window_painted_impl`) deliberately never steals OS focus
 * either — see the #267 PR notes.
 */
export function NotificationWindow() {
  useApplyA11yChrome();
  const { suggestion, projectsById, confirm, dismiss } =
    useNotificationWindow();

  // Escape dismisses (and snoozes), same as the inline banner's keyboard
  // affordance — but no focus trap: Tab moves through the two buttons in
  // natural document order and can leave the window entirely.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss]);

  if (!suggestion) {
    // Nothing pending yet (the cold-start race before `pending_notification`
    // resolves, typically resolved within the same frame the backend shows
    // the window click-through). Render nothing rather than a flash of
    // empty card chrome; the paint ack only fires once real content mounts
    // below, so the backend keeps the window click-through until then.
    return null;
  }

  return (
    <section
      className="idle-win notify-win"
      aria-label="Auto-detected work"
      // A non-blocking notification, not a dialog: announce via the live
      // region rather than claiming a role this window doesn't honor (no
      // focus trap, no aria-modal, no forced choice).
      aria-live="assertive"
    >
      <div className="suggest-head">
        <Icon name="sparkle" size={13} />
        <span>Detected</span>
        <button
          className="suggest-x"
          aria-label="Dismiss suggestion"
          onClick={() => void dismiss()}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className="suggest-body">
        {suggestion.project ? (
          <>
            Working on{" "}
            <ProjectChip project={projectsById[suggestion.project]} />
          </>
        ) : (
          <>Detected</>
        )}{" "}
        — <em>{suggestion.ruleName}</em>?
        {suggestion.tags.length > 0 && (
          <span className="suggest-tags">
            {suggestion.tags.map((t) => (
              <Tag key={t}>{t}</Tag>
            ))}
          </span>
        )}
      </div>
      <div className="suggest-why">
        <SuggestWhy signals={suggestion.matchedSignals ?? []} />
      </div>
      <div className="suggest-actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void confirm()}
        >
          <Icon name="check" size={13} /> Confirm
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => void dismiss()}
        >
          Dismiss
        </button>
      </div>
    </section>
  );
}
