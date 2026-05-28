import { Fragment, useState, type ReactNode } from "react";
import { Icon } from "../../lib/icon";
import { Kbd } from "../../lib/components";
import { useBackup } from "../../lib/use-backup";
import { SHORTCUTS, emitToast } from "../../lib/shortcuts";
import { useAnnounce } from "../../lib/use-announce";
import type { UseA11yPrefs } from "../../lib/use-a11y-prefs";
import type { UseSignalCapture } from "../../lib/use-signal-capture";
import type {
  AmbiguityBehavior,
  Density,
  DetectionPrompts,
  TextScale,
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
}

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
}: Props) {
  const backup = useBackup();
  const announce = useAnnounce();
  const [confirmCapture, setConfirmCapture] = useState(false);

  const resetShortcuts = () => {
    const msg = "Shortcuts already at defaults";
    announce(msg);
    emitToast(msg);
  };

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
    <div className="view view-settings" data-density={density}>
      <section className="privacy-card" aria-label="Privacy">
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

      <section className="settings-block">
        <h3 className="settings-h">Never track these</h3>
        <p className="settings-sub">
          Cairn won't observe these apps, URLs, or windows — not even to count
          idle time.
        </p>
        <ul className="excl-list">
          <li className="excl-row">
            <Icon name="lock" size={12} />
            <code>1Password</code>
            <span className="excl-kind">app</span>
            <button className="excl-x" aria-label="Remove">
              <Icon name="x" size={11} />
            </button>
          </li>
          <li className="excl-row">
            <Icon name="lock" size={12} />
            <code>*.bank.com</code>
            <span className="excl-kind">domain</span>
            <button className="excl-x" aria-label="Remove">
              <Icon name="x" size={11} />
            </button>
          </li>
          <li className="excl-row">
            <Icon name="lock" size={12} />
            <code>Messages</code>
            <span className="excl-kind">app</span>
            <button className="excl-x" aria-label="Remove">
              <Icon name="x" size={11} />
            </button>
          </li>
          <li className="excl-row excl-add">
            <Icon name="plus" size={12} />
            <input
              placeholder="Add an app, domain, or window title pattern…"
              aria-label="Add exclusion"
            />
          </li>
        </ul>
        <label className="settings-check">
          <input type="checkbox" defaultChecked />
          <span>Pause tracking on private/incognito browser windows</span>
        </label>
      </section>

      <section className="settings-block">
        <h3 className="settings-h">Accessibility</h3>
        <p className="settings-sub">Cairn should be usable by everyone.</p>

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

      <section className="settings-block" aria-labelledby="shortcuts-h">
        <div className="settings-row-head">
          <h3 className="settings-h" id="shortcuts-h">
            Shortcuts
          </h3>
          <button
            type="button"
            className="link-btn"
            onClick={resetShortcuts}
          >
            Reset to defaults
          </button>
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

      <section className="settings-block" aria-label="Advanced">
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
