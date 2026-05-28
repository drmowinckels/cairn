import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PALETTE_OPEN_DOM_EVENT,
  SHORTCUTS,
  SHORTCUT_TOGGLE_TIMER_EVENT,
  TOAST_DOM_EVENT,
  emitToast,
  requestOpenPalette,
} from "./shortcuts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shortcuts metadata (issue #33)", () => {
  it("exposes every binding listed in the spec, in the spec's order", () => {
    expect(SHORTCUTS.map((s) => s.id)).toEqual([
      "toggle-popover",
      "toggle-timer",
      "command-palette",
      "switch-view",
      "confirm",
      "dismiss",
    ]);
  });

  it("the global toggle-popover binding is ⌃⌥T", () => {
    const sc = SHORTCUTS.find((s) => s.id === "toggle-popover");
    expect(sc?.keys).toEqual(["⌃", "⌥", "T"]);
    expect(sc?.scope).toBe("global");
  });

  it("the global toggle-timer binding is ⌃⌥␣", () => {
    const sc = SHORTCUTS.find((s) => s.id === "toggle-timer");
    expect(sc?.keys).toEqual(["⌃", "⌥", "␣"]);
    expect(sc?.scope).toBe("global");
  });

  it("the palette binding is ⌘K and scoped to the popover", () => {
    const sc = SHORTCUTS.find((s) => s.id === "command-palette");
    expect(sc?.keys).toEqual(["⌘", "K"]);
    expect(sc?.scope).toBe("popover");
  });

  it("the switch-view binding shows the 1–4 range", () => {
    const sc = SHORTCUTS.find((s) => s.id === "switch-view");
    expect(sc?.keys).toEqual(["1", "–", "4"]);
  });

  it("the confirm binding is the return key", () => {
    expect(SHORTCUTS.find((s) => s.id === "confirm")?.keys).toEqual(["↵"]);
  });

  it("the dismiss binding is Esc", () => {
    expect(SHORTCUTS.find((s) => s.id === "dismiss")?.keys).toEqual(["Esc"]);
  });
});

describe("shortcut event constants", () => {
  it("SHORTCUT_TOGGLE_TIMER_EVENT matches the Rust constant string", () => {
    // Rust side: `popover::SHORTCUT_TOGGLE_TIMER_EVENT`. If either
    // side renames without the other, the binding silently breaks
    // because Tauri's event bus is name-based.
    expect(SHORTCUT_TOGGLE_TIMER_EVENT).toBe("shortcut:toggle-timer");
  });

  it("PALETTE_OPEN_DOM_EVENT is a window-scoped name", () => {
    expect(PALETTE_OPEN_DOM_EVENT).toBe("cairn:open-palette");
  });

  it("TOAST_DOM_EVENT is a window-scoped name", () => {
    expect(TOAST_DOM_EVENT).toBe("cairn:toast");
  });
});

describe("requestOpenPalette()", () => {
  it("dispatches a CustomEvent on window", () => {
    const handler = vi.fn();
    window.addEventListener(PALETTE_OPEN_DOM_EVENT, handler);
    requestOpenPalette();
    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener(PALETTE_OPEN_DOM_EVENT, handler);
  });
});

describe("emitToast()", () => {
  it("dispatches a CustomEvent carrying the message as detail", () => {
    const handler = vi.fn();
    window.addEventListener(TOAST_DOM_EVENT, handler);
    emitToast("Timer started");
    expect(handler).toHaveBeenCalledTimes(1);
    const evt = handler.mock.calls[0][0] as CustomEvent<string>;
    expect(evt.detail).toBe("Timer started");
    window.removeEventListener(TOAST_DOM_EVENT, handler);
  });
});
