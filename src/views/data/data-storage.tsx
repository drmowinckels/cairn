import { Icon } from "../../lib/icon";
import { useBackup } from "../../lib/use-backup";
import { useAutoBackup } from "../../lib/use-auto-backup";
import { useRoundingPrefs } from "../../lib/use-rounding-prefs";
import { PRIVACY_GUARANTEES, formatBytes } from "../../lib/privacy-copy";
import { formatRelativeTime } from "../../lib/relative-time";
import { backupHealth, backupHealthMessage } from "../../lib/backup-staleness";

const INTERVAL_OPTIONS: Array<{ hours: number; label: string }> = [
  { hours: 6, label: "Every 6 hours" },
  { hours: 12, label: "Every 12 hours" },
  { hours: 24, label: "Daily" },
  { hours: 168, label: "Weekly" },
];

const KEEP_OPTIONS = [7, 14, 30];

/**
 * Automatic-backup controls (data resilience): point Cairn at a synced
 * folder and it writes rolling, point-in-time snapshots so a lost device
 * doesn't lose tracked time. Snapshots — not the live DB — so a cloud
 * folder never risks SQLite corruption.
 */
function AutoBackupPanel() {
  const ab = useAutoBackup();
  const { settings, status } = ab;
  const health = backupHealth(settings, status);
  // `backupHealthMessage` returns copy only for the unhealthy states
  // (`stale` / `never`) and `null` for `off` / `ok`, so a non-null
  // message is exactly when the warning banner should show.
  const warningMessage = backupHealthMessage(health, status);

  return (
    <div className="auto-backup" aria-label="Automatic backup">
      <h3 className="settings-section-title">Automatic backup</h3>
      <p className="settings-sub">
        Keep rolling snapshots in a folder your OS already syncs (iCloud Drive,
        Google Drive, Dropbox, Syncthing). Cairn writes whole-file snapshots,
        never the live database, so the synced copy can't corrupt.
      </p>

      {settings.dir ? (
        <>
          <p className="auto-backup-folder">
            <Icon name="folder" size={12} />
            <code>{settings.dir}</code>
            <button className="link-btn" onClick={ab.chooseFolder}>
              Change…
            </button>
          </p>
          <label className="auto-backup-toggle">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(e) => void ab.setEnabled(e.target.checked)}
            />
            <span>Back up automatically</span>
          </label>
          <div className="auto-backup-row">
            <label>
              Frequency
              <select
                value={settings.intervalHours}
                aria-label="Backup frequency"
                onChange={(e) =>
                  void ab.setIntervalHours(Number(e.target.value))
                }
              >
                {INTERVAL_OPTIONS.map((o) => (
                  <option key={o.hours} value={o.hours}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Keep
              <select
                value={settings.keep}
                aria-label="Snapshots to keep"
                onChange={(e) => void ab.setKeep(Number(e.target.value))}
              >
                {KEEP_OPTIONS.map((k) => (
                  <option key={k} value={k}>
                    {k} snapshots
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="auto-backup-row">
            <button className="btn btn--ghost btn--sm" onClick={ab.backupNow}>
              Back up now
            </button>
            <span className="auto-backup-meta">
              {status.count > 0
                ? `${status.count} snapshot${status.count === 1 ? "" : "s"} · last ${formatRelativeTime(status.lastBackupAt)}`
                : "No snapshots yet"}
            </span>
          </div>
          {warningMessage && (
            <div className="privacy-banner privacy-banner--error" role="alert">
              <Icon name="x" size={13} />
              <span>{warningMessage}</span>
            </div>
          )}
        </>
      ) : (
        <button className="btn btn--ghost btn--sm" onClick={ab.chooseFolder}>
          Choose backup folder…
        </button>
      )}

      {ab.op.kind !== "idle" && (
        <div
          className={`privacy-banner privacy-banner--${ab.op.kind}`}
          role={ab.op.kind === "error" ? "alert" : "status"}
        >
          <Icon name={ab.op.kind === "error" ? "x" : "check"} size={13} />
          <span>{ab.op.message}</span>
        </div>
      )}
    </div>
  );
}

// The data-locality guarantees live with the storage controls; the
// "source / licence" guarantee stays in Settings (it isn't about storage).
const DATA_GUARANTEES = PRIVACY_GUARANTEES.filter((g) => g.id !== "source");

/**
 * Local data storage actions — export / restore / CSV / reveal / delete
 * plus the on-disk file list and status banners. Relocated out of
 * Settings → Privacy into the Data tab so all data management lives in
 * one place; Settings keeps only the privacy contract.
 */
export function DataStorageActions() {
  const backup = useBackup();
  const { rounding } = useRoundingPrefs();

  return (
    <section className="data-storage" aria-label="Local data storage">
      <div className="privacy-head">
        <Icon name="shield" size={18} />
        <h2 className="privacy-title">Your data stays here</h2>
      </div>
      <ul className="privacy-list">
        {DATA_GUARANTEES.map((g) => (
          <li key={g.id}>
            <Icon name="check" size={13} />
            <span>
              <strong>{g.lead}</strong> {g.rest}
            </span>
          </li>
        ))}
      </ul>
      <p className="settings-sub">
        Everything is a single SQLite file on this machine. Back it up or
        restore it by saving that file anywhere — including a folder synced by
        iCloud Drive, Google Drive, or Syncthing. Cairn never talks to those
        services itself.
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
          onClick={() => backup.exportCsvToFile(rounding)}
        >
          Export CSV…
        </button>
        <button
          className="btn btn--ghost btn--sm"
          onClick={() => backup.exportJsonToFile(rounding)}
        >
          Export JSON…
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
      <AutoBackupPanel />
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
  );
}
