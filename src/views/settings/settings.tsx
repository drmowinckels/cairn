import { type ReactNode } from "react";
import { Icon } from "../../lib/icon";
import { Kbd } from "../../lib/components";
import { useBackup } from "../../lib/use-backup";
import type { UseA11yPrefs } from "../../lib/use-a11y-prefs";
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

interface Props {
  density: Density;
  a11y: UseA11yPrefs;
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

export function SettingsView({ density, a11y }: Props) {
  const backup = useBackup();
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

      <section className="settings-block">
        <h3 className="settings-h">Shortcuts</h3>
        <ul className="short-list">
          <li>
            <span>Open / hide Cairn</span>
            <span className="kbds">
              <Kbd>⌃</Kbd>
              <Kbd>⌥</Kbd>
              <Kbd>T</Kbd>
            </span>
          </li>
          <li>
            <span>Start / stop timer</span>
            <span className="kbds">
              <Kbd>⌃</Kbd>
              <Kbd>⌥</Kbd>
              <Kbd>␣</Kbd>
            </span>
          </li>
          <li>
            <span>Confirm suggestion</span>
            <span className="kbds">
              <Kbd>↵</Kbd>
            </span>
          </li>
          <li>
            <span>Change project</span>
            <span className="kbds">
              <Kbd>⌘</Kbd>
              <Kbd>K</Kbd>
            </span>
          </li>
          <li>
            <span>Switch view</span>
            <span className="kbds">
              <Kbd>1</Kbd>–<Kbd>4</Kbd>
            </span>
          </li>
        </ul>
      </section>

      <section className="settings-block">
        <h3 className="settings-h">Integrations</h3>
        <ul className="intg-list">
          <li className="intg-row">
            <Icon name="calendar" size={14} />
            <span className="intg-name">Calendar</span>
            <span className="intg-status">3 accounts · read-only</span>
            <button className="link-btn">Configure…</button>
          </li>
          <li className="intg-row">
            <Icon name="branch" size={14} />
            <span className="intg-name">Git</span>
            <span className="intg-status">4 watched repos</span>
            <button className="link-btn">Manage…</button>
          </li>
          <li className="intg-row">
            <Icon name="globe" size={14} />
            <span className="intg-name">Browsers</span>
            <span className="intg-status">Safari, Firefox · via extension</span>
            <button className="link-btn">Install…</button>
          </li>
        </ul>
      </section>

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
