import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { Icon } from "../../lib/icon";
import { AboutCard } from "../settings/about-card";
import { hideAboutWindow } from "../../lib/about-window";
import { aboutWindowPainted } from "../../lib/ipc";
import { useApplyA11yChrome } from "../../lib/use-apply-a11y-chrome";
import { useFocusTrap } from "../../lib/use-focus-trap";

/** Emitted by the tray every time the About window is shown (#300). */
export const ABOUT_SHOWN_EVENT = "about:shown";

interface Props {
  /** Injected for tests; defaults to hiding the real window. */
  onClose?: () => void | Promise<void>;
  /** Injected for tests; defaults to the real paint-ack command. */
  onPainted?: typeof aboutWindowPainted;
  /** Injected for tests; defaults to the real Tauri event listener. */
  listenFn?: typeof listen;
}

/**
 * The small About window (`?win=about`), opened from the tray's "About Cairn"
 * item. Reuses the Settings {@link AboutCard} (version, maker, links,
 * copy-diagnostics) under a minimal title bar with a close button; Escape
 * closes too. The header is a drag region so the frameless window can be moved.
 */
export function AboutWindow({
  onClose = hideAboutWindow,
  onPainted = aboutWindowPainted,
  listenFn = listen,
}: Props) {
  useApplyA11yChrome();
  const trap = useFocusTrap(() => void onClose());

  // Confirm to the backend that this webview actually painted (#300). Until
  // the ack lands the window is shown click-through with a watchdog poised
  // to hide it, so a webview that never renders can't become an invisible
  // input trap. Waits for a paint frame so the ack reflects real rendering,
  // not just a committed React render. Acked on mount (covering the very
  // first show, and a webview that mounts after the show event) and again on
  // every later show — the window is hidden rather than closed, so it never
  // remounts.
  useEffect(() => {
    let raf = 0;
    const ack = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        void onPainted().catch((e) =>
          console.error("about_window_painted failed", e),
        );
      });
    };
    ack();
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listenFn(ABOUT_SHOWN_EVENT, ack)
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((e) => console.error("about:shown listener failed", e));
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      unlisten?.();
    };
  }, [onPainted, listenFn]);

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
      <header className="about-win-head">
        {/* Only the title is the drag handle — a `data-tauri-drag-region` on
            the whole header makes macOS swallow the close button's click. */}
        <span className="about-win-title" data-tauri-drag-region>
          About
        </span>
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
