import { useEffect, useState } from "react";
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
import { CalendarManager } from "./calendar-manager";

const EXTENSION_INSTALL_URL =
  "https://github.com/drmowinckels/cairn#browser-extension";

export function IntegrationsCard() {
  const [calendarOpen, setCalendarOpen] = useState(false);
  return (
    <section
      className="settings-block"
      aria-label="Integrations"
      data-section="integrations"
    >
      <h3 className="settings-h">Integrations</h3>
      <ul className="intg-list">
        <CalendarStatusLine onManage={() => setCalendarOpen(true)} />
        <GitStatusLine />
        <BrowserStatusLine installHref={EXTENSION_INSTALL_URL} />
      </ul>
      {calendarOpen && (
        <CalendarManager onClose={() => setCalendarOpen(false)} />
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
  const lastSync = syncedTimes.length > 0 ? syncedTimes[syncedTimes.length - 1] : undefined;

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
        onClick={() => {
          /* roots configurator lands with the full watcher in M7 */
        }}
      >
        Configure roots…
      </button>
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
  const text = connected
    ? `Connected${label ? ` (${label})` : ""}`
    : "Not installed";

  const onInstall = () => {
    openUrl(installHref).catch(() => {
      window.open(installHref, "_blank", "noopener");
    });
  };

  return (
    <li className="intg-row" data-integration="browser">
      <Icon name="globe" size={14} />
      <span className="intg-name">Browsers</span>
      <span className="intg-status">{text}</span>
      <button type="button" className="link-btn" onClick={onInstall}>
        {connected ? "Manage…" : "Install…"}
      </button>
    </li>
  );
}
