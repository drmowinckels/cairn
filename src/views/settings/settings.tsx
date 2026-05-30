import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../lib/icon";
import { Kbd } from "../../lib/components";
import { useBackup } from "../../lib/use-backup";
import { useExclusions, guessExclusionKind } from "../../lib/use-exclusions";
import { SHORTCUTS } from "../../lib/shortcuts";
import type { UseA11yPrefs } from "../../lib/use-a11y-prefs";
import type { UseSignalCapture } from "../../lib/use-signal-capture";
import type {
  AmbiguityBehavior,
  Density,
  DetectionPrompts,
  TextScale,
  ThemePref,
} from "../../lib/types";
import { AMBIGUITY_OPTIONS as AMBIGUITY_VALUES } from "../../lib/use-rules";
import {
  formatBytes,
  PRIVACY_GUARANTEES,
  PRIVACY_LICENSE_LABEL,
  PRIVACY_REPO_LABEL,
  PRIVACY_REPO_URL,
} from "../../lib/privacy-copy";
import { IntegrationsCard } from "./integrations";

/**
 * Anchors the command palette's "Open settings: X" commands can
 * target. Each setting <section> is tagged with `data-section`
 * matching one of these ids; SettingsView scrolls the matching
 * section into view when `scrollToSection` changes.
 */
export type SettingsSectionId =
  | "privacy"
  | "exclusions"
  | "accessibility"
  | "shortcuts"
  | "integrations"
  | "calendar"
  | "advanced";

interface Props {
  density: Density;
  a11y: UseA11yPrefs;
  capture: UseSignalCapture;
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
}

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
  { value: "modal", label: "Modal" },
];

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
  onRerunOnboarding,
  scrollToSection = null,
  scrollNonce = 0,
}: Props) {
  const backup = useBackup();
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
    <div
      className="view view-settings"
      data-density={density}
      ref={rootRef}
    >
      <section
        className="privacy-card"
        aria-label="Privacy"
        data-section="privacy"
      >
        <div className="privacy-head">
          <Icon name="shield" size={18} />
          <h2 className="privacy-title">Your data stays here</h2>
        </div>
        <ul className="privacy-list">
          {PRIVACY_GUARANTEES.map((g) => (
            <li key={g.id}>
              <Icon name="check" size={13} />
              <span>
                <strong>{g.lead}</strong> {g.rest}
              </span>
            </li>
          ))}
        </ul>
        <p className="privacy-hint">
          Backup or restore by saving the database file anywhere — including a
          folder synced by iCloud Drive, Google Drive, or Syncthing. Cairn
          never talks to those services itself.
        </p>
        <div className="privacy-actions">
          <button
            className="btn btn--ghost btn--sm"
            onClick={backup.exportBackupToFile}
          >
            Export all data…
          </button>
          <button
            className="btn btn--ghost btn--sm"
            onClick={backup.importBackupFromFile}
          >
            Restore from file…
          </button>
          <button
            className="btn btn--ghost btn--sm"
            onClick={backup.exportCsvToFile}
          >
            Export CSV…
          </button>
          <button
            className="btn btn--ghost btn--sm"
            onClick={backup.revealDataFolder}
          >
            View what's stored
          </button>
          <button
            className="btn btn--ghost btn--sm privacy-danger"
            onClick={backup.deleteAllData}
          >
            Delete everything…
          </button>
        </div>
        {backup.dataFiles.length > 0 && (
          <ul
            className="privacy-files"
            aria-label="Files currently stored on this machine"
          >
            {backup.dataFiles.map((file) => (
              <li key={file.name}>
                <Icon name="folder" size={11} />
                <code>{file.name}</code>
                <span className="privacy-files-size">
                  {formatBytes(file.sizeBytes)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="privacy-attrib">
          <a
            href={PRIVACY_REPO_URL}
            target="_blank"
            rel="noreferrer noopener"
          >
            {PRIVACY_REPO_LABEL}
          </a>{" "}
          · {PRIVACY_LICENSE_LABEL}
        </p>
        {backup.pendingImport && (
          <div className="privacy-banner privacy-banner--pending" role="status">
            <Icon name="info" size={13} />
            <span>
              A restore is staged and will apply the next time Cairn starts.
            </span>
            <button className="link-btn" onClick={backup.cancelImport}>
              Cancel
            </button>
          </div>
        )}
        {backup.status.kind !== "idle" && (
          <div
            className={`privacy-banner privacy-banner--${backup.status.kind}`}
            role={backup.status.kind === "error" ? "alert" : "status"}
          >
            <Icon
              name={backup.status.kind === "error" ? "x" : "check"}
              size={13}
            />
            <span>{backup.status.message}</span>
          </div>
        )}
      </section>

      <section className="settings-block" data-section="exclusions">
        <h3 className="settings-h">Never track these</h3>
        <p className="settings-sub">
          Cairn won't observe these apps, URLs, or windows — not even to count
          idle time.
        </p>
        <ExclusionsSection />
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

        <SetRow label="High contrast" hint="Stronger borders and text contrast.">
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
          hint="How insistent should auto-detection be?"
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

      <IntegrationsCard />

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

      <section
        className="settings-block"
        aria-label="Advanced"
        data-section="advanced"
      >
        <h3 className="settings-h">Advanced</h3>
        <p className="settings-sub">
          Troubleshooting tools. Off by default and never persisted across
          launches.
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
              troubleshooting and stop it when you're done — Cairn deletes
              the file when you turn this off.
            </p>
            <p className="capture-confirm-body">
              Capture stops automatically when you quit Cairn. The toggle is
              never persisted: the next launch always starts with capture
              off.
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
        Cairn v0.0.1 · {PRIVACY_LICENSE_LABEL} ·{" "}
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

function SetRow({ label, hint, children }: SetRowProps) {
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

function Toggle({ on, onChange, label }: ToggleProps) {
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

const INCOGNITO_PREF_KEY = "cairn:pause-on-incognito:v1";

/**
 * The "Never track these" list, wired to the exclusion commands
 * (list/save/delete). The add field infers the kind from the input
 * (see `guessExclusionKind`). The incognito toggle has no backend yet —
 * the browser extension will read this preference — so it persists to
 * localStorage rather than the DB.
 */
function ExclusionsSection() {
  const excl = useExclusions();
  const [draft, setDraft] = useState("");
  const [pauseIncognito, setPauseIncognito] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(INCOGNITO_PREF_KEY) !== "false";
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(INCOGNITO_PREF_KEY, String(pauseIncognito));
    } catch {
      /* ignore quota errors */
    }
  }, [pauseIncognito]);

  const submit = () => {
    const value = draft.trim();
    if (!value) return;
    void excl.add(guessExclusionKind(value), value).then(() => setDraft(""));
  };

  return (
    <>
      <ul className="excl-list">
        {excl.exclusions.map((e) => (
          <li className="excl-row" key={e.id}>
            <Icon name="lock" size={12} />
            <code>{e.value}</code>
            <span className="excl-kind">{e.kind}</span>
            <button
              className="excl-x"
              aria-label={`Remove ${e.value}`}
              onClick={() => void excl.remove(e.id)}
            >
              <Icon name="x" size={11} />
            </button>
          </li>
        ))}
        <li className="excl-row excl-add">
          <Icon name="plus" size={12} />
          <input
            placeholder="Add an app, domain, or window title pattern…"
            aria-label="Add exclusion"
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
        </li>
      </ul>
      {excl.error && <p className="field-error">{excl.error}</p>}
      <label className="settings-check">
        <input
          type="checkbox"
          checked={pauseIncognito}
          onChange={(e) => setPauseIncognito(e.currentTarget.checked)}
        />
        <span>Pause tracking on private/incognito browser windows</span>
      </label>
    </>
  );
}
