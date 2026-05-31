import { Icon } from "../../lib/icon";
import { useBackup } from "../../lib/use-backup";
import { formatBytes } from "../../lib/privacy-copy";

/**
 * Local data storage actions — export / restore / CSV / reveal / delete
 * plus the on-disk file list and status banners. Relocated out of
 * Settings → Privacy into the Data tab so all data management lives in
 * one place; Settings keeps only the privacy contract.
 */
export function DataStorageActions() {
  const backup = useBackup();

  return (
    <section className="data-storage" aria-label="Local data storage">
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
          <Icon name={backup.status.kind === "error" ? "x" : "check"} size={13} />
          <span>{backup.status.message}</span>
        </div>
      )}
    </section>
  );
}
