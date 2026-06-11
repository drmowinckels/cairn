import { useEffect } from "react";
import { Icon } from "../../lib/icon";
import { fmtClockFromIso, fmtIdleDuration } from "../../lib/time";
import { useIdleWindow } from "../../lib/use-idle-window";
import { useApplyA11yChrome } from "../../lib/use-apply-a11y-chrome";
import { useFocusTrap } from "../../lib/use-focus-trap";
import type { IdleChoice } from "../../lib/ipc";

interface ChoiceDef {
  choice: IdleChoice;
  label: string;
  hint: string;
}

/** The four #93 resolutions, in order of likely use. */
const CHOICES: ChoiceDef[] = [
  {
    choice: "keep",
    label: "Keep in this session",
    hint: "Count the idle time as work on the current entry.",
  },
  {
    choice: "discard-continue",
    label: "Discard, keep tracking",
    hint: "Drop the idle gap and carry on the same work.",
  },
  {
    choice: "new-session",
    label: "Discard, start new session",
    hint: "Drop the idle gap and begin a fresh, blank entry.",
  },
  {
    choice: "discard",
    label: "Discard and stop",
    hint: "Drop the idle gap and stop tracking.",
  },
];

/**
 * The dedicated idle-time prompt window (#93). Rendered when the app
 * loads under `?win=idle`. Asks the user what to do with the period
 * they were away while a timer kept running.
 */
export function IdleWindow() {
  const { prompt, tracking, resolve, dismiss } = useIdleWindow();
  useApplyA11yChrome();
  const trap = useFocusTrap(() => void dismiss());

  // Dismiss (no change — idle stays as work) on Escape. The trap handles
  // Escape when focus is inside the dialog; this window-level listener
  // covers the brief window before mount-focus lands.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss]);

  // Focus the dialog itself on mount so keyboard users land inside the
  // forced-choice trap rather than on the body (CLAUDE.md §4, §6).
  useEffect(() => {
    const node = trap.ref.current;
    if (!node) return;
    const id = window.requestAnimationFrame(() => node.focus());
    return () => window.cancelAnimationFrame(id);
  }, [trap.ref]);

  return (
    // Focus-trapped modal: onKeyDown handles Escape/Tab. The dialog role is
    // non-interactive but key handling here is the standard modal pattern,
    // not a clickable control.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      className="idle-win"
      role="dialog"
      aria-modal="true"
      aria-labelledby="idle-win-h"
      tabIndex={-1}
      ref={trap.ref}
      onKeyDown={trap.onKeyDown}
    >
      <header className="idle-win-head">
        <Icon name="moon" size={16} />
        <h1 id="idle-win-h" className="idle-win-title">
          You were away
        </h1>
        <button
          type="button"
          className="icon-btn"
          aria-label="Dismiss"
          onClick={() => void dismiss()}
        >
          <Icon name="x" size={13} />
        </button>
      </header>

      <p className="idle-win-sub">
        {prompt ? (
          <>
            No input from <strong>{fmtClockFromIso(prompt.since)}</strong> to{" "}
            <strong>{fmtClockFromIso(prompt.until)}</strong>
            <span className="idle-win-dur">
              {fmtIdleDuration(prompt.durationSeconds)}
            </span>
          </>
        ) : (
          "Checking what you were tracking…"
        )}
      </p>

      {tracking ? (
        <p className="idle-win-tracking">
          Tracking <strong>{tracking.projectName ?? "No project"}</strong>
          {tracking.description ? <> · {tracking.description}</> : null}
        </p>
      ) : null}

      <ul className="idle-win-choices">
        {CHOICES.map((c) => (
          <li key={c.choice}>
            <button
              type="button"
              className="idle-choice"
              onClick={() => void resolve(c.choice)}
              disabled={!prompt}
            >
              <span className="idle-choice-label">{c.label}</span>
              <span className="idle-choice-hint">{c.hint}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
