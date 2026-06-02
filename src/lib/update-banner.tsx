import { openUrl } from "@tauri-apps/plugin-opener";
import { Icon } from "./icon";
import type { UpdateInfo } from "./ipc";

interface UpdateBannerProps {
  update: UpdateInfo | null;
  onDismiss: () => void;
}

/**
 * Non-blocking "update available" banner shown in the popover footer when
 * the opt-in update check (#45) finds a newer release. Lives just above
 * `pop-foot`, mirroring the capture banner. Clicking the version opens the
 * GitHub release-notes page in the default browser; the × dismisses it for
 * that version. Renders nothing when there's no update.
 */
export function UpdateBanner({ update, onDismiss }: UpdateBannerProps) {
  if (!update) return null;

  const open = () => {
    openUrl(update.releaseUrl).catch(() => {
      window.open(update.releaseUrl, "_blank", "noopener");
    });
  };

  return (
    <div
      className="update-banner"
      role="status"
      aria-live="polite"
      data-testid="update-banner"
    >
      <Icon name="sparkle" size={12} />
      <span className="update-text">Cairn {update.version} is available</span>
      <button type="button" className="link-btn update-notes" onClick={open}>
        Release notes
      </button>
      <button
        type="button"
        className="icon-btn update-dismiss"
        aria-label="Dismiss update notice"
        onClick={onDismiss}
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}
