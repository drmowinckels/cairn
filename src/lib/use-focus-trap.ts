import { useCallback, useRef, type KeyboardEvent, type RefObject } from "react";

/**
 * Tabbable descendants of `root`, in document order, skipping hidden /
 * aria-hidden / disabled elements. `offsetParent === null` filters out
 * `display:none` subtrees (good enough for our modals, which don't use
 * `position:fixed` on their focusables).
 */
export function focusableElements(root: HTMLElement): HTMLElement[] {
  const selector =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => !el.hasAttribute("aria-hidden") && el.offsetParent !== null,
  );
}

export interface FocusTrap {
  /** Attach to the modal container (give it `tabIndex={-1}`). */
  ref: RefObject<HTMLDivElement | null>;
  /** Wire to the container's `onKeyDown`: Escape closes, Tab cycles. */
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
}

/**
 * Standard modal keyboard behaviour shared by every dialog: Escape calls
 * `onEscape`, and Tab / Shift+Tab cycle focus within the container so it
 * never escapes the modal. Initial focus is the caller's responsibility
 * (each modal focuses a different element on open).
 */
export function useFocusTrap(onEscape: () => void): FocusTrap {
  const ref = useRef<HTMLDivElement | null>(null);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onEscape();
        return;
      }
      if (e.key !== "Tab") return;
      const root = ref.current;
      if (!root) return;
      const focusables = focusableElements(root);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onEscape],
  );

  return { ref, onKeyDown };
}
