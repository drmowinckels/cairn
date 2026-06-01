import { Icon } from "../../lib/icon";
import { ProjectChip } from "../../lib/components";
import type { DetectionPrompts, RuleMatchEvent } from "../../lib/types";

interface Props {
  /** The switch suggestion to render, or null to render nothing. */
  match: RuleMatchEvent | null;
  /** Reuses the detection-prompt presentation setting (subtle/modal). */
  style: Exclude<DetectionPrompts, "off">;
  announce: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}

/**
 * The #105 task-switch prompt: shown when a *different* project's rule has
 * been the top match long enough to look like the user changed task. It only
 * *offers* — "Switch" stops the current timer and starts the matched project;
 * "Keep current" snoozes the rule. Mirrors the suggestion banner's styling so
 * it inherits the reduced-motion handling.
 */
export function TaskSwitchBanner({
  match,
  style,
  announce,
  onConfirm,
  onDismiss,
}: Props) {
  if (!match) return null;
  return (
    <section
      className={`suggest suggest--${style}`}
      aria-label="Task switch detected"
      aria-live={announce ? "polite" : "off"}
      role={style === "modal" ? "alertdialog" : undefined}
    >
      <div className="suggest-head">
        <Icon name="sparkle" size={13} />
        <span>Switched task?</span>
        <button
          className="suggest-x"
          onClick={onDismiss}
          aria-label="Keep current timer"
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className="suggest-body">
        Looks like you switched to{" "}
        {match.project ? (
          <ProjectChip id={match.project} />
        ) : (
          <em>{match.ruleName}</em>
        )}{" "}
        — <em>{match.ruleName}</em>.
      </div>
      <div className="suggest-actions">
        <button className="btn btn--primary" onClick={onConfirm}>
          <Icon name="check" size={13} /> Switch
        </button>
        <button className="btn btn--ghost" onClick={onDismiss}>
          Keep current
        </button>
      </div>
    </section>
  );
}
