export type ShortcutScope = "global" | "popover";

export interface ShortcutBinding {
  id: string;
  keys: string[];
  label: string;
  scope: ShortcutScope;
}

export const SHORTCUTS: ShortcutBinding[] = [
  {
    id: "toggle-popover",
    keys: ["⌃", "⌥", "T"],
    label: "Open / hide Cairn",
    scope: "global",
  },
  {
    id: "toggle-timer",
    keys: ["⌃", "⌥", "␣"],
    label: "Start / stop timer",
    scope: "global",
  },
  {
    id: "command-palette",
    keys: ["⌘", "K"],
    label: "Command palette",
    scope: "popover",
  },
  {
    id: "switch-view",
    keys: ["1", "–", "4"],
    label: "Switch view",
    scope: "popover",
  },
  {
    id: "confirm",
    keys: ["↵"],
    label: "Confirm suggestion",
    scope: "popover",
  },
  {
    id: "dismiss",
    keys: ["Esc"],
    label: "Dismiss / close",
    scope: "popover",
  },
];

export const SHORTCUT_TOGGLE_TIMER_EVENT = "shortcut:toggle-timer";
export const PALETTE_OPEN_DOM_EVENT = "cairn:open-palette";
export const TOAST_DOM_EVENT = "cairn:toast";

export function requestOpenPalette(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PALETTE_OPEN_DOM_EVENT));
}

export function emitToast(message: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<string>(TOAST_DOM_EVENT, { detail: message }),
  );
}
