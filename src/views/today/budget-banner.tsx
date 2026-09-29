import { Icon } from "../../lib/icon";
import { fmtHm } from "../../lib/time";
import type { BudgetStatus } from "../../lib/ipc";

interface Props {
  status: BudgetStatus;
  style: "subtle" | "modal";
  announce: boolean;
  onDismiss: () => void;
  /** Opens Settings at the budgets section so the cap can be adjusted. */
  onAdjust?: () => void;
}

const PERIOD_NOUN: Record<string, string> = {
  daily: "today",
  weekly: "this week",
  monthly: "this month",
};

/** What the budget covers, in the user's words. The scope id isn't resolved
 *  to a name here — the banner is about the hours, and a project budget
 *  firing while you work on that project is already unambiguous. */
function scopeNoun(scopeType: string): string {
  if (scopeType === "project") return "on this project";
  if (scopeType === "client") return "for this client";
  return "";
}

export function budgetMessage(status: BudgetStatus): string {
  const period = PERIOD_NOUN[status.budget.period] ?? "this period";
  const scope = scopeNoun(status.budget.scopeType);
  const where = scope ? ` ${scope}` : "";
  const used = fmtHm(status.usedMinutes);
  const cap = fmtHm(status.budget.minutes);

  if (status.state === "over") {
    const overBy = fmtHm(
      Math.max(0, status.usedMinutes - status.budget.minutes),
    );
    return `You've tracked ${used}${where} ${period} — ${overBy} past your ${cap} budget.`;
  }
  return `You've tracked ${used} of your ${cap} budget${where} ${period}.`;
}

/**
 * Work-hour budget warning (#307).
 *
 * Reports only. There is deliberately no "stop the timer" action: a budget is
 * a warning about how much you've worked, and Cairn ending a session on your
 * behalf would destroy real time data to enforce a number the user set as
 * guidance.
 */
export function BudgetBanner({
  status,
  style,
  announce,
  onDismiss,
  onAdjust,
}: Props) {
  const over = status.state === "over";
  return (
    <section
      className={`suggest suggest--${style}`}
      data-budget-state={status.state}
      aria-label={over ? "Over budget" : "Approaching budget"}
      // Inline notification, not a dialog — announce via the live region,
      // matching the other Today banners.
      aria-live={
        announce ? (style === "modal" ? "assertive" : "polite") : "off"
      }
    >
      <div className="suggest-head">
        <Icon name={over ? "shield" : "info"} size={13} />
        <span>{over ? "Over budget" : "Approaching budget"}</span>
        <button
          className="suggest-x"
          onClick={onDismiss}
          aria-label="Dismiss budget warning"
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className="suggest-body">{budgetMessage(status)}</div>
      <div className="suggest-actions">
        {onAdjust && (
          <button className="btn btn--ghost" onClick={onAdjust}>
            Adjust budget
          </button>
        )}
        <button className="btn btn--ghost" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </section>
  );
}
