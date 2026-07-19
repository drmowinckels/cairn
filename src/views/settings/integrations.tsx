import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Icon } from "../../lib/icon";
import { useCalendars } from "../../lib/use-calendars";
import { formatRelativeTime } from "../../lib/relative-time";
import {
  browserExtensionStatus,
  getGitWatcherStatus,
  type BrowserExtensionStatus,
  type GitWatcherStatus,
} from "../../lib/ipc";
import { useAutostart } from "../../lib/use-autostart";
import { useAutostartRepairNotice } from "../../lib/use-autostart-repair-notice";
import { autostartCopy, detectPlatform } from "../../lib/autostart-copy";
import { CalendarManager } from "./calendar-manager";
import { GitRootsManager } from "./git-roots-manager";

const EXTENSION_INSTALL_URL =
  "https://github.com/drmowinckels/cairn#browser-extension";

export function IntegrationsCard() {
  const [calendarOpen, setCalendarOpen] = useState(false);
  // The status line and the manager each own a `useCalendars()`; remounting
  // the status line when the manager closes re-fetches it so a source added
  // (or removed) in the manager is reflected here instead of going stale.
  const [calendarNonce, setCalendarNonce] = useState(0);
  return (
    <section
      className="settings-block"
      aria-label="Integrations"
      data-section="integrations"
    >
      <h3 className="settings-h">Integrations</h3>
      <ul className="intg-list">
        <CalendarStatusLine
          key={calendarNonce}
          onManage={() => setCalendarOpen(true)}
        />
        <GitStatusLine />
        <BrowserStatusLine installHref={EXTENSION_INSTALL_URL} />
        <AutostartStatusLine />
      </ul>
      <AutostartRepairNoticeBanner />
      {calendarOpen && (
        <CalendarManager
          onClose={() => {
            setCalendarOpen(false);
            setCalendarNonce((n) => n + 1);
          }}
        />
      )}
    </section>
  );
}

interface CalendarStatusLineProps {
  onManage: () => void;
}

export function CalendarStatusLine({ onManage }: CalendarStatusLineProps) {
  const { sources } = useCalendars();
  const enabled = sources.filter((s) => s.enabled);
  const syncedTimes = enabled
    .map((s) => s.lastSyncedAt)
    .filter((s): s is string => s != null)
    .sort();
  const lastSync =
    syncedTimes.length > 0 ? syncedTimes[syncedTimes.length - 1] : undefined;

  const status =
    enabled.length === 0
      ? "No sources yet"
      : `${enabled.length} ${enabled.length === 1 ? "source" : "sources"} · last sync ${formatRelativeTime(lastSync ?? null)}`;

  return (
    <li className="intg-row" data-integration="calendar">
      <Icon name="calendar" size={14} />
      <span className="intg-name">Calendar</span>
      <span className="intg-status">{status}</span>
      <button type="button" className="link-btn" onClick={onManage}>
        Manage…
      </button>
    </li>
  );
}

export function GitStatusLine() {
  const [status, setStatus] = useState<GitWatcherStatus | null>(null);
  const [configuring, setConfiguring] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getGitWatcherStatus().then((next) => {
      if (!cancelled) setStatus(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const roots = status?.discoveryRoots ?? ["~/code"];
  const count = status?.watchedCount ?? 0;
  const rootLabel = roots.length === 1 ? roots[0] : `${roots.length} folders`;
  const text =
    count === 1
      ? `Watching 1 repo under ${rootLabel}`
      : `Watching ${count} repos under ${rootLabel}`;

  return (
    <li className="intg-row" data-integration="git">
      <Icon name="branch" size={14} />
      <span className="intg-name">Git</span>
      <span className="intg-status">{text}</span>
      <button
        type="button"
        className="link-btn"
        onClick={() => setConfiguring(true)}
      >
        Configure roots…
      </button>
      {configuring && (
        <GitRootsManager
          onClose={() => setConfiguring(false)}
          onSaved={(next) => setStatus(next)}
        />
      )}
    </li>
  );
}

interface BrowserStatusLineProps {
  installHref: string;
}

export function BrowserStatusLine({ installHref }: BrowserStatusLineProps) {
  const [status, setStatus] = useState<BrowserExtensionStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    browserExtensionStatus().then((next) => {
      if (!cancelled) setStatus(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const connected = status?.connected ?? false;
  const label = status?.browserLabel?.trim();
  // The browser extension isn't published yet (#37); until it is, there's
  // nowhere to install from, so the install action is disabled rather than
  // sending the user to the source repo.
  const text = connected
    ? `Connected${label ? ` (${label})` : ""}`
    : "Coming soon";

  const onManage = () => {
    openUrl(installHref).catch(() => {
      window.open(installHref, "_blank", "noopener");
    });
  };

  return (
    <li className="intg-row" data-integration="browser">
      <Icon name="globe" size={14} />
      <span className="intg-name">Browsers</span>
      <span className="intg-status">{text}</span>
      {connected ? (
        <button type="button" className="link-btn" onClick={onManage}>
          Manage…
        </button>
      ) : (
        <button
          type="button"
          className="link-btn"
          disabled
          title="The browser extension isn't published yet (#37)."
        >
          Install…
        </button>
      )}
    </li>
  );
}

export function AutostartStatusLine() {
  const { enabled, busy, error, ready, toggle } = useAutostart();
  const copy = useMemo(() => autostartCopy(detectPlatform()), []);

  const status = error ? `Toggle failed: ${error}` : enabled ? "On" : "Off";

  return (
    <li className="intg-row" data-integration="autostart">
      <Icon name="sparkle" size={14} />
      <span className="intg-name">{copy.label}</span>
      <span className="intg-status">{status}</span>
      <button
        type="button"
        className={`tgl${enabled ? " is-on" : ""}`}
        role="switch"
        aria-checked={enabled}
        aria-label={copy.label}
        title={copy.hint}
        onClick={() => {
          void toggle(!enabled);
        }}
        disabled={!ready || busy}
      >
        <span className="tgl-dot" />
      </button>
    </li>
  );
}

/**
 * One-time notice (#264): startup detected and repaired a stale
 * launch-at-login LaunchAgent — one baked before #263's dev-build guard
 * existed, pointing at a since-removed dev build or a
 * relocated/uninstalled bundle. Backend-driven and persisted, so it
 * survives across restarts until dismissed (mirrors the pending-restore
 * banner in Data → Local storage).
 */
export function AutostartRepairNoticeBanner() {
  const { message, dismiss } = useAutostartRepairNotice();
  if (!message) return null;

  return (
    <div
      className="privacy-banner privacy-banner--pending"
      role="status"
      data-integration="autostart-repair-notice"
    >
      <Icon name="info" size={13} />
      <span>{message}</span>
      <button className="link-btn" onClick={() => void dismiss()}>
        Dismiss
      </button>
    </div>
  );
}
