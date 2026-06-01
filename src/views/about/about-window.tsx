import { useEffect } from "react";
import { Icon } from "../../lib/icon";
import { AboutCard } from "../settings/about-card";
import { hideAboutWindow } from "../../lib/about-window";

interface Props {
  /** Injected for tests; defaults to hiding the real window. */
  onClose?: () => void | Promise<void>;
}

/**
 * The small About window (`?win=about`), opened from the tray's "About Cairn"
 * item. Reuses the Settings {@link AboutCard} (version, maker, links,
 * copy-diagnostics) under a minimal title bar with a close button; Escape
 * closes too. The header is a drag region so the frameless window can be moved.
 */
export function AboutWindow({ onClose = hideAboutWindow }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="about-win"
      role="dialog"
      aria-modal="true"
      aria-label="About Cairn"
    >
      <header className="about-win-head" data-tauri-drag-region>
        <span className="about-win-title">About</span>
        <button
          className="about-win-close"
          aria-label="Close"
          title="Close"
          onClick={() => void onClose()}
        >
          <Icon name="x" size={14} />
        </button>
      </header>
      <AboutCard />
    </div>
  );
}
