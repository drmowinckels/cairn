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

function CairnGlyph() {
  return (
    <svg
      className="about-mark"
      width="22"
      height="24"
      viewBox="0 0 16 18"
      aria-hidden="true"
      focusable="false"
    >
      <path
        className="stone stone--base"
        d="M1.4 14.6 C0.8 13.4 1.1 12.2 2.4 11.7 C4.8 10.8 9.4 10.6 12.6 11.5 C14.2 11.9 14.9 12.9 14.6 14.1 C14.2 15.5 12.5 16.6 9.6 16.9 C6.4 17.3 3.3 16.7 1.9 15.6 C1.7 15.4 1.5 15.0 1.4 14.6 Z"
      />
      <path
        className="stone stone--mid"
        d="M3.5 9.8 C3.2 8.9 3.7 8.0 5.0 7.6 C6.9 7.0 9.7 7.1 11.2 7.7 C12.2 8.1 12.5 8.9 12.0 9.7 C11.4 10.7 9.7 11.3 7.5 11.3 C5.5 11.3 4.0 10.8 3.5 9.8 Z"
      />
      <path
        className="stone stone--top"
        d="M5.6 5.2 C5.4 4.4 6.1 3.7 7.4 3.5 C8.6 3.3 9.9 3.6 10.3 4.3 C10.7 5.0 10.1 5.8 8.7 6.0 C7.3 6.2 5.9 6.0 5.6 5.2 Z"
      />
    </svg>
  );
}
