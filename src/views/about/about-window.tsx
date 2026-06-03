import { useEffect } from "react";
import { Icon } from "../../lib/icon";
import { AboutCard } from "../settings/about-card";
import { hideAboutWindow } from "../../lib/about-window";
import { useApplyA11yChrome } from "../../lib/use-apply-a11y-chrome";
import { useFocusTrap } from "../../lib/use-focus-trap";

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
  useApplyA11yChrome();
  const trap = useFocusTrap(() => void onClose());

  // The trap handles Escape when focus is inside the dialog; this
  // window-level listener covers the brief window before mount-focus lands.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Focus the dialog itself on mount so Tab/Shift+Tab cycle inside it.
  useEffect(() => {
    const node = trap.ref.current;
    if (!node) return;
    const id = window.requestAnimationFrame(() => node.focus());
    return () => window.cancelAnimationFrame(id);
  }, [trap.ref]);

  return (
    // Focus-trapped modal: onKeyDown handles Escape/Tab. The dialog role is
    // non-interactive but key handling here is the standard modal pattern,
    // not a clickable control.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      className="about-win"
      role="dialog"
      aria-modal="true"
      aria-label="About Cairn"
      tabIndex={-1}
      ref={trap.ref}
      onKeyDown={trap.onKeyDown}
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
