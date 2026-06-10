import { useEffect, useState } from "react";
import { Icon } from "../../lib/icon";
import { diagnostics, type Diagnostics } from "../../lib/ipc";
import {
  PRIVACY_LICENSE_LABEL,
  PRIVACY_REPO_URL,
} from "../../lib/privacy-copy";

const AUTHOR = "Athanasia Monika Mowinckel";
const AUTHOR_URL = "https://github.com/drmowinckels";

/** Render the diagnostics bundle as plain text for a bug report. */
export function formatDiagnostics(d: Diagnostics | null): string {
  if (!d) return "Cairn — dev build (diagnostics unavailable outside the app)";
  return [
    `Cairn v${d.appVersion}`,
    `Platform: ${d.os}/${d.arch}`,
    `Projects: ${d.projects} · Clients: ${d.clients} · Rules: ${d.rules}`,
    `Exclusions: ${d.exclusions} · Entries: ${d.entries}`,
  ].join("\n");
}

/**
 * About + diagnostics. Shows the app version and maker, and a
 * "Copy diagnostics" button that puts a privacy-safe report (version,
 * platform, table counts — never names/titles) on the clipboard for
 * bug reports.
 */
export function AboutCard() {
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );

  useEffect(() => {
    let cancelled = false;
    diagnostics()
      .then((d) => {
        if (!cancelled) setDiag(d);
      })
      .catch((e) => console.warn("diagnostics failed", e));
    return () => {
      cancelled = true;
    };
  }, []);

  const version = diag?.appVersion ?? "dev";

  const copy = async () => {
    const text = formatDiagnostics(diag);
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch (e) {
      console.warn("clipboard write failed", e);
      setCopyState("failed");
    }
    window.setTimeout(() => setCopyState("idle"), 2000);
  };

  const copyLabel =
    copyState === "copied"
      ? "Copied diagnostics"
      : copyState === "failed"
        ? "Copy failed"
        : "Copy diagnostics";

  return (
    <div className="about-card">
      <div className="about-head">
        <CairnGlyph />
        <div>
          <p className="about-name">
            Cairn <span className="about-version">v{version}</span>
          </p>
          <p className="about-by">
            by{" "}
            <a href={AUTHOR_URL} target="_blank" rel="noreferrer noopener">
              {AUTHOR}
            </a>
          </p>
        </div>
      </div>
      <p className="settings-sub">
        Local-first time tracking with passive auto-detection.{" "}
        <a href={PRIVACY_REPO_URL} target="_blank" rel="noreferrer noopener">
          GitHub
        </a>{" "}
        · {PRIVACY_LICENSE_LABEL}
      </p>
      <p className="settings-sub about-companion">
        Looking for a break reminder?{" "}
        <a
          href="https://entracte.drmowinckels.io/"
          target="_blank"
          rel="noreferrer noopener"
        >
          Try Entracte
        </a>
        , Cairn's sibling app.
      </p>
      <div className="about-actions">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => void copy()}
        >
          <Icon name={copyState === "copied" ? "check" : "folder"} size={12} />{" "}
          {copyLabel}
        </button>
        <span className="about-hint">
          For bug reports — version + platform + counts, no personal data.
        </span>
      </div>
    </div>
  );
}

/**
 * The official Cairn mark — four stacked stones, matching
 * `public/logo-mark-*.svg`. The cap takes the accent; the rest read as
 * `--ink` at increasing weight so the mark adapts to light and dark themes.
 */
function CairnGlyph() {
  return (
    <svg
      className="about-mark"
      width="36"
      height="36"
      viewBox="0 0 60 60"
      role="img"
      aria-label="Cairn"
    >
      <g transform="translate(-0.64980221,-0.58659697)">
        <path
          className="stone stone--cap"
          d="m 20.750242,2.2444906 h 12.083333 c 2.192917,0 3.958333,1.7654167 3.958333,3.9583333 v 4.0833331 c 0,2.192917 -1.765416,3.958334 -3.958333,3.958334 H 20.750242 c -2.192917,0 -3.958334,-1.765417 -3.958334,-3.958334 V 6.2028239 c 0,-2.1929166 1.765417,-3.9583333 3.958334,-3.9583333 z"
        />
        <path
          className="stone stone--high"
          d="m 22.615082,15.13923 h 22.016807 c 2.211344,0 3.991597,1.780252 3.991597,3.991596 v 5.016807 c 0,2.211345 -1.780253,3.991597 -3.991597,3.991597 H 22.615082 c -2.211344,0 -3.991596,-1.780252 -3.991596,-3.991597 v -5.016807 c 0,-2.211344 1.780252,-3.991596 3.991596,-3.991596 z"
        />
        <path
          className="stone stone--mid"
          d="m 10.493841,29.033966 h 26.880342 c 2.249145,0 4.059829,1.810684 4.059829,4.059829 v 5.880342 c 0,2.249145 -1.810684,4.059829 -4.059829,4.059829 H 10.493841 c -2.2491454,0 -4.0598291,-1.810684 -4.0598291,-4.059829 v -5.880342 c 0,-2.249145 1.8106837,-4.059829 4.0598291,-4.059829 z"
        />
        <path
          className="stone stone--base"
          d="M 7.1444504,43.928703 H 54.155154 c 2.213035,0 3.994648,1.781613 3.994648,3.994649 v 7.010703 c 0,2.213035 -1.781613,3.994648 -3.994648,3.994648 H 7.1444504 c -2.2130351,0 -3.9946482,-1.781613 -3.9946482,-3.994648 v -7.010703 c 0,-2.213036 1.7816131,-3.994649 3.9946482,-3.994649 z"
        />
      </g>
    </svg>
  );
}
