import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../lib/icon";
import { Kbd } from "../../lib/components";
import { SHORTCUTS } from "../../lib/shortcuts";
import type { UseA11yPrefs } from "../../lib/use-a11y-prefs";
import type { UsePopoverSize, PopoverSize } from "../../lib/use-popover-size";
import type { UseTrayDetail } from "../../lib/use-tray-detail";
import type { UseRoundingPrefs } from "../../lib/use-rounding-prefs";
import type { UseWorkingHours } from "../../lib/use-working-hours";
import type { UseTaskSwitchPrefs } from "../../lib/use-task-switch-prefs";
import type { UseRequiredFieldsPrefs } from "../../lib/use-required-fields-prefs";
import type { UseUpdatePrefs } from "../../lib/use-update-prefs";
import type { UseSignalCapture } from "../../lib/use-signal-capture";
import type { UseActivityLog } from "../../lib/use-activity-log";
import { ActivityLogCard } from "./activity-log-card";
import {
  ROUNDING_INTERVALS,
  ROUND_MODES,
  isRoundingActive,
  roundingLabel,
  type RoundMode,
} from "../../lib/rounding";
import type {
  AmbiguityBehavior,
  Density,
  DetectionPrompts,
  TextScale,
  ThemePref,
} from "../../lib/types";
import { AMBIGUITY_OPTIONS as AMBIGUITY_VALUES } from "../../lib/use-rules";
import {
  PRIVACY_LICENSE_LABEL,
  PRIVACY_REPO_LABEL,
  PRIVACY_REPO_URL,
} from "../../lib/privacy-copy";

/**
 * Anchors the command palette's "Open settings: X" commands can
 * target. Each setting <section> is tagged with `data-section`
 * matching one of these ids; SettingsView scrolls the matching
 * section into view when `scrollToSection` changes.
 */
export type SettingsSectionId =
  | "privacy"
  | "accessibility"
  | "shortcuts"
  | "updates"
  | "activity-log"
  | "diagnostics";

interface Props {
  density: Density;
  a11y: UseA11yPrefs;
  capture: UseSignalCapture;
  /**
   * Opt-in activity-log controls (#190). Optional so tests can render
   * without it; when absent the Activity log section is hidden.
   */
  activityLog?: UseActivityLog;
  /**
   * Re-arm the first-run onboarding overlay (issue #31). Settings
   * shells the action as "Run onboarding again"; the parent popover
   * wires the `useOnboarding().reset` mutator. Optional so the
   * settings tests can render the view without onboarding state.
   */
  onRerunOnboarding?: () => Promise<void> | void;
  /**
   * Identifier of the section to scroll into view (palette #32).
   * The popover increments `scrollNonce` to force the effect to fire
   * even when the same section is targeted twice in a row.
   */
  scrollToSection?: SettingsSectionId | null;
  /** Monotonically-incrementing token so repeat targets re-fire. */
  scrollNonce?: number;
  /**
   * Popover size preset control (issue #1). Optional so settings tests
   * can render without the live window hook; when absent the row is
   * hidden.
   */
  popoverSize?: UsePopoverSize;
  /**
   * Menu-bar tray "show tracked project" preference. Optional so tests
   * can render without it; when absent the row is hidden.
   */
  trayDetail?: UseTrayDetail;
  /**
   * Global time-rounding preference (issue #107). Optional so tests can
   * render without it; when absent the rounding rows are hidden.
   */
  rounding?: UseRoundingPrefs;
  /**
   * Working-hours reminder preference (issue #99). Optional so tests can
   * render without it; when absent the reminder rows are hidden.
   */
  workingHours?: UseWorkingHours;
  /**
   * Task-switch prompt preference (issue #105). Optional so tests can render
   * without it; when absent the switch rows are hidden.
   */
  taskSwitch?: UseTaskSwitchPrefs;
  /**
   * Required-fields-on-stop preference (issue #108). Optional so tests can
   * render without it; when absent the section is hidden.
   */
  requiredFields?: UseRequiredFieldsPrefs;
  /**
   * Opt-in update-checker preference (issue #45). Optional so tests can
   * render without it; when absent the Updates section is hidden.
   */
  updatePrefs?: UseUpdatePrefs;
}

const POPOVER_SIZES: Array<{ value: PopoverSize; label: string }> = [
  { value: "compact", label: "Compact" },
  { value: "large", label: "Large" },
];

const MODE_LABEL: Record<RoundMode, string> = {
  nearest: "Nearest",
  up: "Up",
  down: "Down",
};

const THEME_OPTIONS: Array<{ value: ThemePref; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const TEXT_SCALES: Array<{ value: TextScale; label: string }> = [
  { value: "sm", label: "A−" },
  { value: "md", label: "Aa" },
  { value: "lg", label: "A+" },
  { value: "xl", label: "A++" },
];

const DETECTION_OPTIONS: Array<{ value: DetectionPrompts; label: string }> = [
  { value: "off", label: "Off" },
  { value: "subtle", label: "Subtle" },
  { value: "notification", label: "Notification" },
];

const REMINDER_THROTTLES = [15, 30, 60, 120];
const REMINDER_IDLE_MINUTES = [5, 10, 15, 30];
const TASK_SWITCH_DWELLS = [30, 60, 120, 300];

/** minutes-since-midnight → "HH:MM" for an `<input type="time">`. */
export function minutesToHhMm(minutes: number): string {
  const clamped = Math.min(Math.max(0, Math.floor(minutes)), 24 * 60 - 1);
  const hh = String(Math.floor(clamped / 60)).padStart(2, "0");
  const mm = String(clamped % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** "HH:MM" → minutes-since-midnight; `null` when unparseable. */
export function hhMmToMinutes(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

/**
 * Settings-specific labels for each `AmbiguityBehavior`. Derived
 * from the canonical `AMBIGUITY_VALUES` so a future fourth variant
 * forces this map to grow (TS will error: missing key). Without the
 * derivation, a new variant could land in `use-rules.ts` and silently
 * miss the Settings UI.
 */
const AMBIGUITY_LABELS: Record<AmbiguityBehavior, string> = {
  prompt: "Prompt",
  skip: "Skip",
  "log-to-uncategorized": "Uncategorized",
};

const AMBIGUITY_OPTIONS: Array<{
  value: AmbiguityBehavior;
  label: string;
}> = AMBIGUITY_VALUES.map((value) => ({
  value,
  label: AMBIGUITY_LABELS[value],
}));

export function SettingsView({
  density,
  a11y,
  capture,
  activityLog,
  onRerunOnboarding,
  scrollToSection = null,
  scrollNonce = 0,
  popoverSize,
  trayDetail,
  rounding,
  workingHours,
  taskSwitch,
  requiredFields,
  updatePrefs,
}: Props) {
  const [confirmCapture, setConfirmCapture] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!scrollToSection) return;
    const root = rootRef.current;
    if (!root) return;
    const target = root.querySelector<HTMLElement>(
      `[data-section="${scrollToSection}"]`,
    );
    if (!target) return;
    // `block:start` aligns the section header at the top of the
    // scrollable popover body, which is the most useful position for
    // a section the user just navigated to.
    target.scrollIntoView({ block: "start", behavior: "auto" });
    // Drop a focus target so screen readers announce the section.
    target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  }, [scrollToSection, scrollNonce]);

  const requestStartCapture = () => setConfirmCapture(true);
  const confirmStartCapture = async () => {
    try {
      await capture.start();
    } finally {
      setConfirmCapture(false);
    }
  };
  const cancelConfirm = () => setConfirmCapture(false);
  const stopCapture = () => {
    void capture.stop();
  };
  return (
    <div className="view view-settings" data-density={density} ref={rootRef}>
      <section
        className="privacy-card"
        aria-label="Privacy"
        data-section="privacy"
      >
        <div className="privacy-head">
          <Icon name="shield" size={18} />
          <h2 className="privacy-title">Local-first &amp; open source</h2>
        </div>
        <p className="privacy-hint">
          Cairn never talks to a server — your data is a single file on this
          machine. The full privacy guarantees and your storage controls (back
          up, export, delete) live in the <strong>Data</strong> tab.
        </p>
        <p className="privacy-attrib">
          <a href={PRIVACY_REPO_URL} target="_blank" rel="noreferrer noopener">
            {PRIVACY_REPO_LABEL}
          </a>{" "}
          · {PRIVACY_LICENSE_LABEL}
        </p>
      </section>

      <section className="settings-block" data-section="accessibility">
        <h3 className="settings-h">Accessibility</h3>
        <p className="settings-sub">Cairn should be usable by everyone.</p>

        <SetRow label="Theme" hint="Match your system, or force light or dark.">
          <div className="seg seg--sm" role="radiogroup" aria-label="Theme">
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                role="radio"
                aria-checked={a11y.theme === opt.value}
                className={`seg-btn${a11y.theme === opt.value ? " is-on" : ""}`}
                onClick={() => a11y.setTheme(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </SetRow>

        <SetRow label="Text size" hint="Scales the whole UI.">
          <div className="seg seg--sm" role="radiogroup" aria-label="Text size">
            {TEXT_SCALES.map((opt) => (
              <button
                key={opt.value}
                role="radio"
                aria-checked={a11y.textScale === opt.value}
                className={`seg-btn${a11y.textScale === opt.value ? " is-on" : ""}`}
                onClick={() => a11y.setTextScale(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </SetRow>

        {popoverSize && (
          <SetRow
            label="Popover size"
            hint="Compact stays out of the way; large gives reports more room."
          >
            <div
              className="seg seg--sm"
              role="radiogroup"
              aria-label="Popover size"
            >
              {POPOVER_SIZES.map((opt) => (
                <button
                  key={opt.value}
                  role="radio"
                  aria-checked={popoverSize.size === opt.value}
                  className={`seg-btn${popoverSize.size === opt.value ? " is-on" : ""}`}
                  onClick={() => popoverSize.setSize(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </SetRow>
        )}

        {trayDetail && (
          <SetRow
            label="Show project in menu bar"
            hint="Display the currently-tracked project (or “Idle”) beside the tray icon."
          >
            <Toggle
              on={trayDetail.enabled}
              onChange={trayDetail.setEnabled}
              label="Show project in menu bar"
            />
          </SetRow>
        )}

        <SetRow
          label="High contrast"
          hint="Stronger borders and text contrast."
        >
          <Toggle
            on={a11y.highContrast}
            onChange={a11y.setHighContrast}
            label="High contrast"
          />
        </SetRow>

        <SetRow
          label="Reduce motion"
          hint="Disable timeline animations and idle pulse."
        >
          <Toggle
            on={a11y.reduceMotion}
            onChange={a11y.setReduceMotion}
            label="Reduce motion"
          />
        </SetRow>

        <SetRow
          label="Colorblind-safe palette"
          hint="Swap project colors for an Okabe–Ito palette."
        >
          <Toggle
            on={a11y.colorblindSafe}
            onChange={a11y.setColorblindSafe}
            label="Colorblind-safe palette"
          />
        </SetRow>

        <SetRow
          label="Screen reader announcements"
          hint="Announce timer start/stop and detection prompts."
        >
          <Toggle
            on={a11y.announce}
            onChange={a11y.setAnnounce}
            label="Screen reader announcements"
          />
        </SetRow>

        <SetRow
          label="Focus rings always visible"
          hint="Show focus indicators even when navigating with a mouse."
        >
          <Toggle
            on={a11y.alwaysFocusRing}
            onChange={a11y.setAlwaysFocusRing}
            label="Focus rings always visible"
          />
        </SetRow>

        <SetRow
          label="Detection prompts"
          hint="Subtle shows an inline banner in Today; Notification pops a small always-on-top window instead, so a match isn't missed while you're on another tab or the popover is closed."
        >
          <div
            className="seg seg--sm"
            role="radiogroup"
            aria-label="Detection prompts"
          >
            {DETECTION_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                role="radio"
                aria-checked={a11y.detectionPrompts === opt.value}
                className={`seg-btn${a11y.detectionPrompts === opt.value ? " is-on" : ""}`}
                onClick={() => a11y.setDetectionPrompts(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </SetRow>

        <SetRow
          label="Default ambiguity behaviour"
          hint="What to do when a Suggestive rule matches. Applies to new rules only."
        >
          <div
            className="seg seg--sm"
            role="radiogroup"
            aria-label="Default ambiguity behaviour"
          >
            {AMBIGUITY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                role="radio"
                aria-checked={a11y.ambiguityDefault === opt.value}
                className={`seg-btn${a11y.ambiguityDefault === opt.value ? " is-on" : ""}`}
                onClick={() => a11y.setAmbiguityDefault(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </SetRow>
      </section>

      {rounding && (
        <section className="settings-block" aria-label="Time rounding">
          <h3 className="settings-h">Reporting</h3>
          <p className="settings-sub">
            Rounding is applied to reports and CSV export only — your raw start
            and stop times are never changed.
          </p>

          <SetRow
            label="Round time to"
            hint="Each entry's duration is rounded to this interval before it's totalled or exported."
          >
            <select
              className="field-input"
              aria-label="Rounding interval"
              value={rounding.rounding.intervalMinutes}
              onChange={(e) =>
                rounding.setIntervalMinutes(Number(e.target.value))
              }
            >
              {ROUNDING_INTERVALS.map((m) => (
                <option key={m} value={m}>
                  {roundingLabel(m)}
                </option>
              ))}
            </select>
          </SetRow>

          {isRoundingActive(rounding.rounding) && (
            <SetRow
              label="Rounding direction"
              hint="Nearest is fairest; up favours the worker; down favours the client."
            >
              <div
                className="seg seg--sm"
                role="radiogroup"
                aria-label="Rounding direction"
              >
                {ROUND_MODES.map((mode) => (
                  <button
                    key={mode}
                    role="radio"
                    aria-checked={rounding.rounding.mode === mode}
                    className={`seg-btn${rounding.rounding.mode === mode ? " is-on" : ""}`}
                    onClick={() => rounding.setMode(mode)}
                  >
                    {MODE_LABEL[mode]}
                  </button>
                ))}
              </div>
            </SetRow>
          )}
        </section>
      )}

      {workingHours && <WorkingHoursSection workingHours={workingHours} />}
      {taskSwitch && <TaskSwitchSection taskSwitch={taskSwitch} />}
      {requiredFields && (
        <RequiredFieldsSection requiredFields={requiredFields} />
      )}

      <section
        className="settings-block"
        aria-labelledby="shortcuts-h"
        data-section="shortcuts"
      >
        <div className="settings-row-head">
          <h3 className="settings-h" id="shortcuts-h">
            Shortcuts
          </h3>
        </div>
        <ul className="short-list">
          {SHORTCUTS.map((sc) => (
            <li key={sc.id} data-shortcut-id={sc.id}>
              <span>{sc.label}</span>
              <span className="kbds">
                {sc.keys.map((k, i) =>
                  k === "–" ? (
                    <Fragment key={i}>–</Fragment>
                  ) : (
                    <Kbd key={i}>{k}</Kbd>
                  ),
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="settings-block" aria-label="Onboarding">
        <h3 className="settings-h">Onboarding</h3>
        <p className="settings-sub">
          Replay the first-run guided tour. The popover will switch to the
          onboarding overlay on the next render.
        </p>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => {
            if (onRerunOnboarding) void onRerunOnboarding();
          }}
          disabled={!onRerunOnboarding}
        >
          Run onboarding again
        </button>
      </section>

      {updatePrefs && (
        <section
          className="settings-block"
          aria-label="Updates"
          data-section="updates"
        >
          <h3 className="settings-h">Updates</h3>
          <SetRow
            label="Check for updates"
            hint="Off by default. When on, Cairn asks GitHub once on launch (and daily while open) whether a newer version exists, and shows a banner if so. No analytics, no identifier — it's the only network request Cairn makes besides your calendar sources."
          >
            <Toggle
              on={updatePrefs.enabled}
              onChange={updatePrefs.setEnabled}
              label="Check for updates"
            />
          </SetRow>
        </section>
      )}

      {activityLog && <ActivityLogCard activityLog={activityLog} />}

      <section
        className="settings-block"
        aria-label="Diagnostics"
        data-section="diagnostics"
      >
        <h3 className="settings-h">Diagnostics</h3>
        <p className="settings-sub">
          For troubleshooting detection. Off by default and never persisted
          across launches. Cairn's version and links live in the tray's “About
          Cairn” window.
        </p>

        <SetRow
          label="Capture raw signals"
          hint="Write the raw signal stream to a file for debugging detection. Always starts off; disabling deletes the file."
        >
          <Toggle
            on={capture.status.active}
            onChange={(next) => {
              if (next) {
                requestStartCapture();
              } else {
                stopCapture();
              }
            }}
            label="Capture raw signals"
          />
        </SetRow>

        {capture.status.active && capture.status.path && (
          <p
            className="settings-sub settings-sub--mono"
            data-testid="capture-path"
          >
            Writing to <code>{capture.status.path}</code>
          </p>
        )}
        {capture.error && (
          <div className="privacy-banner privacy-banner--error" role="alert">
            <Icon name="x" size={13} />
            <span>{capture.error}</span>
          </div>
        )}
      </section>

      {confirmCapture && (
        <div
          className="capture-confirm-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="capture-confirm-title"
          data-testid="capture-confirm"
        >
          <div className="capture-confirm">
            <h2 id="capture-confirm-title" className="capture-confirm-title">
              <Icon name="info" size={16} /> Capture raw signals?
            </h2>
            <p className="capture-confirm-warn" role="note">
              This writes every window title, app name, browser domain, and
              calendar event Cairn sees to a file on disk. Use it only for
              troubleshooting and stop it when you're done — Cairn deletes the
              file when you turn this off.
            </p>
            <p className="capture-confirm-body">
              Capture stops automatically when you quit Cairn. The toggle is
              never persisted: the next launch always starts with capture off.
            </p>
            <div className="capture-confirm-actions">
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={cancelConfirm}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => {
                  void confirmStartCapture();
                }}
              >
                I understand — capture for this session
              </button>
            </div>
          </div>
        </div>
      )}

      <p className="settings-foot">
        {PRIVACY_LICENSE_LABEL} ·{" "}
        <a href={PRIVACY_REPO_URL} target="_blank" rel="noreferrer noopener">
          github.com/drmowinckels/cairn
        </a>
      </p>
    </div>
  );
}

interface SetRowProps {
  label: string;
  hint?: string;
  children: ReactNode;
}

export function SetRow({ label, hint, children }: SetRowProps) {
  return (
    <div className="set-row">
      <div className="set-row-meta">
        <div className="set-row-label">{label}</div>
        {hint && <div className="set-row-hint">{hint}</div>}
      </div>
      <div className="set-row-ctrl">{children}</div>
    </div>
  );
}

interface ToggleProps {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
}

export function Toggle({ on, onChange, label }: ToggleProps) {
  return (
    <button
      type="button"
      className={`tgl${on ? " is-on" : ""}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    >
      <span className="tgl-dot" />
    </button>
  );
}

interface WorkingHoursSectionProps {
  workingHours: UseWorkingHours;
}

/**
 * The #99 working-hours reminder controls. Off by default. When on, Cairn
 * shows a subtle, non-modal prompt to start tracking when the user is idle
 * during these hours with no timer running — gated by the throttle so it
 * never nags. It only offers; the user's tap starts the timer.
 */
function WorkingHoursSection({ workingHours }: WorkingHoursSectionProps) {
  const { workingHours: cfg } = workingHours;
  return (
    <section className="settings-block" aria-label="Working-hours reminder">
      <h3 className="settings-h">Reminders</h3>
      <p className="settings-sub">
        When you're idle during your working hours with no timer running, Cairn
        can offer to start tracking. It only suggests — nothing is logged until
        you tap.
      </p>

      <SetRow
        label="Remind me to track time"
        hint="Only inside the hours below, and never more often than the throttle."
      >
        <Toggle
          on={cfg.enabled}
          onChange={workingHours.setEnabled}
          label="Remind me to track time"
        />
      </SetRow>

      {cfg.enabled && (
        <>
          <SetRow
            label="Working hours start"
            hint="When the reminder window opens."
          >
            <input
              type="time"
              className="field-input"
              aria-label="Working hours start"
              value={minutesToHhMm(cfg.startMinute)}
              onChange={(e) => {
                const m = hhMmToMinutes(e.target.value);
                if (m !== null) workingHours.setStartMinute(m);
              }}
            />
          </SetRow>

          <SetRow
            label="Working hours end"
            hint="When the reminder window closes."
          >
            <input
              type="time"
              className="field-input"
              aria-label="Working hours end"
              value={minutesToHhMm(cfg.endMinute)}
              onChange={(e) => {
                const m = hhMmToMinutes(e.target.value);
                if (m !== null) workingHours.setEndMinute(m);
              }}
            />
          </SetRow>

          <SetRow
            label="Idle before reminding"
            hint="How long with no input before a reminder is eligible."
          >
            <select
              className="field-input"
              aria-label="Idle before reminding"
              value={cfg.idleMinutes}
              onChange={(e) =>
                workingHours.setIdleMinutes(Number(e.target.value))
              }
            >
              {REMINDER_IDLE_MINUTES.map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
          </SetRow>

          <SetRow
            label="Don't remind more than every"
            hint="The throttle that keeps the reminder from nagging."
          >
            <select
              className="field-input"
              aria-label="Reminder throttle"
              value={cfg.throttleMinutes}
              onChange={(e) =>
                workingHours.setThrottleMinutes(Number(e.target.value))
              }
            >
              {REMINDER_THROTTLES.map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
          </SetRow>
        </>
      )}
    </section>
  );
}

interface TaskSwitchSectionProps {
  taskSwitch: UseTaskSwitchPrefs;
}

/**
 * The #105 task-switch prompt controls. Off by default. When on, Cairn
 * watches for a different project's rule becoming the top match while a timer
 * runs and — after the new rule stays the top match for the dwell window —
 * offers to switch. Gated by the throttle so it never nags; it only offers.
 */
function TaskSwitchSection({ taskSwitch }: TaskSwitchSectionProps) {
  const { prefs } = taskSwitch;
  return (
    <section className="settings-block" aria-label="Task-switch prompt">
      <h3 className="settings-h">Task switching</h3>
      <p className="settings-sub">
        While you're tracking, Cairn can notice when your work looks like a
        different project and offer to switch the timer. It waits until the new
        task sticks, and never asks more often than the throttle.
      </p>

      <SetRow
        label="Ask when I switch tasks"
        hint="Only while a timer is running, after the new task holds for the dwell below."
      >
        <Toggle
          on={prefs.enabled}
          onChange={taskSwitch.setEnabled}
          label="Ask when I switch tasks"
        />
      </SetRow>

      {prefs.enabled && (
        <>
          <SetRow
            label="Wait before asking"
            hint="How long the new task must hold before Cairn asks."
          >
            <select
              className="field-input"
              aria-label="Wait before asking"
              value={prefs.dwellSeconds}
              onChange={(e) =>
                taskSwitch.setDwellSeconds(Number(e.target.value))
              }
            >
              {TASK_SWITCH_DWELLS.map((s) => (
                <option key={s} value={s}>
                  {s < 60 ? `${s} sec` : `${s / 60} min`}
                </option>
              ))}
            </select>
          </SetRow>

          <SetRow
            label="Don't ask more than every"
            hint="The throttle that keeps switch prompts from nagging."
          >
            <select
              className="field-input"
              aria-label="Switch prompt throttle"
              value={prefs.throttleMinutes}
              onChange={(e) =>
                taskSwitch.setThrottleMinutes(Number(e.target.value))
              }
            >
              {REMINDER_THROTTLES.map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
          </SetRow>
        </>
      )}
    </section>
  );
}

interface RequiredFieldsSectionProps {
  requiredFields: UseRequiredFieldsPrefs;
}

/**
 * The #108 required-fields-on-stop controls. Both off by default — Cairn
 * must never block the user unasked. When enabled, stopping the timer while
 * the required field is empty shows an inline (popover-blur-safe) error
 * instead of proceeding.
 */
function RequiredFieldsSection({ requiredFields }: RequiredFieldsSectionProps) {
  const { prefs } = requiredFields;
  return (
    <section className="settings-block" aria-label="Required fields">
      <h3 className="settings-h">Data hygiene</h3>
      <p className="settings-sub">
        Require a project and/or description before stopping a timer, so entries
        don't stay unattributed. Both default off — Cairn won't block you unless
        you ask it to.
      </p>

      <SetRow
        label="Require a project to stop"
        hint="Stopping is blocked until a project is chosen."
      >
        <Toggle
          on={prefs.requireProject}
          onChange={requiredFields.setRequireProject}
          label="Require a project to stop"
        />
      </SetRow>

      <SetRow
        label="Require a description to stop"
        hint="Stopping is blocked until you fill in what you were working on."
      >
        <Toggle
          on={prefs.requireDescription}
          onChange={requiredFields.setRequireDescription}
          label="Require a description to stop"
        />
      </SetRow>
    </section>
  );
}
