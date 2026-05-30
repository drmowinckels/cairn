import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon } from "../../lib/icon";
import {
  PRIVACY_GUARANTEES,
  PRIVACY_LICENSE_LABEL,
  PRIVACY_REPO_LABEL,
  PRIVACY_REPO_URL,
} from "../../lib/privacy-copy";
import { inTauri, saveProject } from "../../lib/ipc";

const ACCESSIBILITY_PREFS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

/**
 * Open macOS' Accessibility privacy pane. Uses the Tauri opener plugin
 * (which handles the `x-apple.systempreferences:` scheme natively);
 * falls back to `window.open` outside Tauri (e.g. browser tests) so the
 * URL is still surfaced. The plugin is imported lazily so the onboarding
 * view renders without it in non-Tauri test environments.
 */
async function openAccessibilitySettings(): Promise<void> {
  if (inTauri) {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(ACCESSIBILITY_PREFS_URL);
      return;
    } catch {
      /* fall through to window.open */
    }
  }
  if (typeof window !== "undefined") {
    window.open(ACCESSIBILITY_PREFS_URL, "_blank", "noopener,noreferrer");
  }
}

/**
 * Linear state machine for first-run onboarding (issue #31).
 *
 * The transition order is `welcome → permissions → projects → browser
 * → done`; `done` is the terminal state — the parent unmounts the
 * overlay once we reach it. "Back" walks the same chain in reverse;
 * "Skip onboarding" jumps straight to `done`.
 */
export type OnboardingStep =
  | "welcome"
  | "permissions"
  | "projects"
  | "browser"
  | "done";

const ORDER: OnboardingStep[] = ["welcome", "permissions", "projects", "browser", "done"];

export function nextStep(step: OnboardingStep): OnboardingStep {
  const idx = ORDER.indexOf(step);
  if (idx < 0 || idx >= ORDER.length - 1) return "done";
  return ORDER[idx + 1];
}

export function prevStep(step: OnboardingStep): OnboardingStep {
  const idx = ORDER.indexOf(step);
  if (idx <= 0) return "welcome";
  return ORDER[idx - 1];
}

export interface SeedProject {
  id: string;
  name: string;
  color: string;
  selected: boolean;
}

export const SEED_PROJECT_PRESETS: ReadonlyArray<Omit<SeedProject, "selected">> = [
  { id: "seed-personal", name: "Personal", color: "#81b29a" },
  { id: "seed-work", name: "Work", color: "#f2cc8f" },
  { id: "seed-os", name: "Open source", color: "#e07a5f" },
] as const;

/**
 * Step metadata for the progress bar / heading. Kept in module scope
 * so the test file can import it without re-deriving the ordering.
 */
export const ONBOARDING_STEPS: ReadonlyArray<{
  step: OnboardingStep;
  index: number;
  title: string;
}> = [
  { step: "welcome", index: 1, title: "Welcome to Cairn" },
  { step: "permissions", index: 2, title: "Permissions" },
  { step: "projects", index: 3, title: "Projects" },
  { step: "browser", index: 4, title: "Browser extension" },
] as const;

interface Props {
  onComplete: () => Promise<void> | void;
  /**
   * Optional override used by the test harness to skip the real
   * `saveProject` IPC. Production callers omit this and let the view
   * call into `lib/ipc.ts`.
   */
  saveSeedProject?: (input: {
    name: string;
    color: string;
  }) => Promise<void>;
}

export function OnboardingView({ onComplete, saveSeedProject }: Props) {
  const [step, setStep] = useState<OnboardingStep>("welcome");
  const [seeds, setSeeds] = useState<SeedProject[]>(() =>
    SEED_PROJECT_PRESETS.map((p) => ({ ...p, selected: true })),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  const advance = useCallback(() => {
    setStep((s) => nextStep(s));
  }, []);

  const back = useCallback(() => {
    setStep((s) => prevStep(s));
  }, []);

  const finalize = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      // Persist any selected seed projects. Empty selection ⇒ nothing
      // to do; the user can always create projects later. The Rust
      // `seed_if_empty` already inserted demo projects on the very
      // first launch, so we only push the user's chosen onboarding
      // seeds — name collisions are tolerated by the DB layer.
      const picked = seeds.filter((s) => s.selected);
      if (picked.length > 0) {
        const persist =
          saveSeedProject ??
          (async (input: { name: string; color: string }) => {
            await saveProject({
              name: input.name,
              color: input.color,
              archived: false,
              clientId: null,
            });
          });
        for (const p of picked) {
          await persist({ name: p.name, color: p.color });
        }
      }
      await onComplete();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }, [seeds, onComplete, saveSeedProject]);

  const skip = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      await onComplete();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }, [onComplete]);

  // Focus the dialog itself on mount + on every step transition so
  // screen-reader users get an updated context announcement.
  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    const id = window.requestAnimationFrame(() => node.focus());
    return () => window.cancelAnimationFrame(id);
  }, [step]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        void skip();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = focusableElements(root);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [skip],
  );

  const meta = useMemo(
    () => ONBOARDING_STEPS.find((s) => s.step === step) ?? ONBOARDING_STEPS[0],
    [step],
  );

  if (step === "done") return null;

  return (
    <div
      className="onboarding-overlay"
      role="presentation"
      data-testid="onboarding-overlay"
    >
      <div
        ref={dialogRef}
        className="onboarding"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="onboarding-head">
          <span className="onboarding-step">
            Step {meta.index} of {ONBOARDING_STEPS.length}
          </span>
          <h2 id={titleId} className="onboarding-title">
            {meta.title}
          </h2>
          <ol
            className="onboarding-progress"
            aria-label="Onboarding progress"
            aria-hidden="true"
          >
            {ONBOARDING_STEPS.map((s) => (
              <li
                key={s.step}
                className={`onboarding-progress-dot${
                  s.index <= meta.index ? " is-active" : ""
                }`}
              />
            ))}
          </ol>
        </header>

        <div className="onboarding-body">
          {step === "welcome" && <WelcomeStep />}
          {step === "permissions" && <PermissionsStep />}
          {step === "projects" && (
            <ProjectsStep seeds={seeds} onChange={setSeeds} />
          )}
          {step === "browser" && <BrowserStep />}
        </div>

        {error && (
          <p className="onboarding-error" role="alert">
            {error}
          </p>
        )}

        <footer className="onboarding-foot">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              void skip();
            }}
            disabled={submitting}
          >
            Skip onboarding
          </button>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={back}
            disabled={submitting || step === "welcome"}
          >
            Back
          </button>
          {step === "browser" ? (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => {
                void finalize();
              }}
              disabled={submitting}
            >
              <Icon name="check" size={13} /> Finish
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={advance}
              disabled={submitting}
            >
              Next
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function WelcomeStep() {
  return (
    <>
      <p className="onboarding-lede">
        Cairn is a local-first time tracker. Before we begin, here's what we
        promise:
      </p>
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
      <p className="onboarding-attrib">
        <a href={PRIVACY_REPO_URL} target="_blank" rel="noreferrer noopener">
          {PRIVACY_REPO_LABEL}
        </a>{" "}
        · {PRIVACY_LICENSE_LABEL}
      </p>
    </>
  );
}

function PermissionsStep() {
  const [autostart, setAutostart] = useState(false);
  const [autostartError, setAutostartError] = useState<string | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [autostartReady, setAutostartReady] = useState(false);

  // Probe the plugin once on mount; outside Tauri the dynamic import
  // simply returns the no-op shape (the plugin's own dev fallback).
  useEffect(() => {
    let cancelled = false;
    if (!inTauri) {
      setAutostartReady(true);
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      try {
        const mod = await import("@tauri-apps/plugin-autostart");
        if (cancelled) return;
        setAutostart(await mod.isEnabled());
      } catch (e) {
        if (!cancelled) setAutostartError(String(e));
      } finally {
        if (!cancelled) setAutostartReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleAutostart = useCallback(
    async (next: boolean) => {
      setAutostartBusy(true);
      setAutostartError(null);
      try {
        if (inTauri) {
          const mod = await import("@tauri-apps/plugin-autostart");
          if (next) await mod.enable();
          else await mod.disable();
        }
        setAutostart(next);
      } catch (e) {
        setAutostartError(String(e));
      } finally {
        setAutostartBusy(false);
      }
    },
    [],
  );

  return (
    <>
      <p className="onboarding-lede">
        Cairn needs a few system permissions to detect what you're working on.
        You can grant these later from your system settings.
      </p>
      <ul className="onboarding-perms">
        <li className="onboarding-perm">
          <Icon name="shield" size={14} />
          <div className="onboarding-perm-body">
            <strong>Accessibility access</strong>
            <p className="onboarding-perm-hint">
              Required on macOS to read the active window title for rule
              matching. Window titles are never persisted.
            </p>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void openAccessibilitySettings()}
          >
            Open settings
          </button>
        </li>
        <li className="onboarding-perm">
          <Icon name="info" size={14} />
          <div className="onboarding-perm-body">
            <strong>Notifications</strong>
            <p className="onboarding-perm-hint">
              Optional — Cairn nudges you when a rule wants to start a timer.
              You'll be prompted on first delivery.
            </p>
          </div>
        </li>
        <li className="onboarding-perm">
          <Icon name="sparkle" size={14} />
          <div className="onboarding-perm-body">
            <strong>Start Cairn at login</strong>
            <p className="onboarding-perm-hint">
              Opt-in. We register a login item so Cairn is ready when you sit
              down to work.
            </p>
          </div>
          <button
            type="button"
            className={`tgl${autostart ? " is-on" : ""}`}
            role="switch"
            aria-checked={autostart}
            aria-label="Start Cairn at login"
            onClick={() => {
              void toggleAutostart(!autostart);
            }}
            disabled={!autostartReady || autostartBusy}
          >
            <span className="tgl-dot" />
          </button>
        </li>
      </ul>
      {autostartError && (
        <p className="onboarding-error" role="status">
          Login-item toggle failed: {autostartError}
        </p>
      )}
    </>
  );
}

interface ProjectsStepProps {
  seeds: SeedProject[];
  onChange: (next: SeedProject[]) => void;
}

function ProjectsStep({ seeds, onChange }: ProjectsStepProps) {
  return (
    <>
      <p className="onboarding-lede">
        Pick a few projects to start with. Rename or deselect anything you
        don't need — you can edit or add more from the Today view later.
      </p>
      <ul className="onboarding-seeds">
        {seeds.map((seed, idx) => (
          <li key={seed.id} className="onboarding-seed">
            <input
              type="checkbox"
              checked={seed.selected}
              aria-label={`Include "${seed.name}"`}
              onChange={(e) => {
                const next = seeds.slice();
                next[idx] = { ...seed, selected: e.target.checked };
                onChange(next);
              }}
            />
            <span
              className="onboarding-seed-swatch"
              style={{ background: seed.color }}
              aria-hidden="true"
            />
            <input
              type="text"
              className="field-input onboarding-seed-name"
              value={seed.name}
              aria-label={`Project name ${idx + 1}`}
              onChange={(e) => {
                const next = seeds.slice();
                next[idx] = { ...seed, name: e.target.value };
                onChange(next);
              }}
            />
          </li>
        ))}
      </ul>
    </>
  );
}

function BrowserStep() {
  return (
    <>
      <p className="onboarding-lede">
        Cairn can detect browser activity through a small open-source
        extension. It pushes the active tab's URL to a local socket — Cairn
        never scrapes your browser history. Installation is optional.
      </p>
      <ul className="onboarding-perms">
        <li className="onboarding-perm">
          <Icon name="globe" size={14} />
          <div className="onboarding-perm-body">
            <strong>Cairn Browser Extension</strong>
            <p className="onboarding-perm-hint">
              Available for Safari, Firefox, and Chromium-based browsers.
            </p>
          </div>
          <a
            href="https://github.com/drmowinckels/cairn-browser"
            target="_blank"
            rel="noreferrer noopener"
            className="btn btn--ghost btn--sm"
          >
            Install
          </a>
        </li>
      </ul>
      <p className="onboarding-hint">
        Prefer to skip this? Cairn works just fine without the extension —
        you'll lose only browser-domain signals.
      </p>
    </>
  );
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  const selector =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => !el.hasAttribute("aria-hidden") && el.offsetParent !== null,
  );
}
