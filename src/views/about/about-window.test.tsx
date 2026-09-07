import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

let useNullTrapRef = false;
const nullRef = {};
Object.defineProperty(nullRef, "current", { get: () => null, set: () => {} });

vi.mock("../../lib/use-focus-trap", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/use-focus-trap")>();
  return {
    ...actual,
    useFocusTrap: (onEscape: () => void) => {
      const trap = actual.useFocusTrap(onEscape);
      return useNullTrapRef
        ? { ...trap, ref: nullRef as typeof trap.ref }
        : trap;
    },
  };
});

import { ABOUT_SHOWN_EVENT, AboutWindow } from "./about-window";

beforeEach(() => {
  localStorage.clear();
  for (const key of Object.keys(document.documentElement.dataset)) {
    delete document.documentElement.dataset[key];
  }
});

afterEach(() => {
  useNullTrapRef = false;
});

describe("AboutWindow", () => {
  it("renders the About card inside a labelled dialog", () => {
    render(<AboutWindow onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: /about cairn/i })).toBeTruthy();
    // AboutCard content is present (its copy-diagnostics action).
    expect(
      screen.getByRole("button", { name: /copy diagnostics/i }),
    ).toBeTruthy();
  });

  it("calls onClose from the × button", () => {
    const onClose = vi.fn();
    render(<AboutWindow onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the close button outside the drag region", () => {
    // A `data-tauri-drag-region` ancestor makes macOS swallow the button's
    // click — the close button must not sit inside one.
    render(<AboutWindow onClose={vi.fn()} />);
    const close = screen.getByRole("button", { name: /^close$/i });
    expect(close.closest("[data-tauri-drag-region]")).toBeNull();
  });

  it("closes on Escape and ignores other keys", () => {
    const onClose = vi.fn();
    render(<AboutWindow onClose={onClose} />);
    fireEvent.keyDown(window, { key: "a" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("defaults to the real hide without throwing outside Tauri", () => {
    render(<AboutWindow />);
    expect(() =>
      fireEvent.click(screen.getByRole("button", { name: /^close$/i })),
    ).not.toThrow();
  });

  it("applies the stored a11y prefs to the document root", () => {
    localStorage.setItem(
      "cairn:a11y-prefs:v1",
      JSON.stringify({ theme: "dark", textScale: "lg", reduceMotion: true }),
    );
    render(<AboutWindow onClose={vi.fn()} />);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.textScale).toBe("lg");
    expect(document.documentElement.dataset.reduceMotion).toBe("on");
  });

  it("focuses the dialog on mount and closes on Escape inside it", async () => {
    const onClose = vi.fn();
    render(<AboutWindow onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: /about cairn/i });
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("skips mount-focus when the dialog ref is unset", () => {
    useNullTrapRef = true;
    const raf = vi.spyOn(window, "requestAnimationFrame");
    render(<AboutWindow onClose={vi.fn()} onPainted={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: /about cairn/i });
    expect(document.activeElement).not.toBe(dialog);
    // The one frame request is the paint ack; mount-focus took the early
    // return instead of scheduling a second.
    expect(raf).toHaveBeenCalledTimes(1);
    raf.mockRestore();
  });

  // ---- #300: paint ack ----

  it("acks paint on mount so the watchdog leaves the window up", async () => {
    const onPainted = vi.fn().mockResolvedValue(undefined);
    render(
      <AboutWindow
        onClose={vi.fn()}
        onPainted={onPainted}
        listenFn={vi.fn().mockResolvedValue(vi.fn())}
      />,
    );
    await waitFor(() => expect(onPainted).toHaveBeenCalledTimes(1));
  });

  it("re-acks paint on every show, not just the first", async () => {
    const onPainted = vi.fn().mockResolvedValue(undefined);
    let fire: (() => void) | undefined;
    const listenFn = vi.fn().mockImplementation((_event, handler) => {
      fire = handler as () => void;
      return Promise.resolve(vi.fn());
    });
    render(
      <AboutWindow
        onClose={vi.fn()}
        onPainted={onPainted}
        listenFn={listenFn}
      />,
    );
    await waitFor(() => expect(onPainted).toHaveBeenCalledTimes(1));
    expect(listenFn).toHaveBeenCalledWith(
      ABOUT_SHOWN_EVENT,
      expect.any(Function),
    );

    // The window is hidden, not closed, so the webview never remounts — a
    // second open must still confirm paint or the watchdog hides it.
    fire?.();
    await waitFor(() => expect(onPainted).toHaveBeenCalledTimes(2));
  });

  it("logs instead of throwing when the paint ack rejects", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const onPainted = vi.fn().mockRejectedValue(new Error("denied"));
    render(
      <AboutWindow
        onClose={vi.fn()}
        onPainted={onPainted}
        listenFn={vi.fn().mockResolvedValue(vi.fn())}
      />,
    );
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        "about_window_painted failed",
        expect.any(Error),
      ),
    );
    error.mockRestore();
  });

  it("logs instead of throwing when the show listener fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <AboutWindow
        onClose={vi.fn()}
        onPainted={vi.fn().mockResolvedValue(undefined)}
        listenFn={vi.fn().mockRejectedValue(new Error("no ipc"))}
      />,
    );
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        "about:shown listener failed",
        expect.any(Error),
      ),
    );
    error.mockRestore();
  });

  it("unsubscribes a listener that resolves after unmount", async () => {
    const unlisten = vi.fn();
    let resolveListen: ((fn: () => void) => void) | undefined;
    const listenFn = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveListen = resolve as (fn: () => void) => void;
        }),
    );
    const { unmount } = render(
      <AboutWindow
        onClose={vi.fn()}
        onPainted={vi.fn().mockResolvedValue(undefined)}
        listenFn={listenFn}
      />,
    );
    unmount();
    resolveListen?.(unlisten);
    await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });

  it("unsubscribes on unmount", async () => {
    const unlisten = vi.fn();
    const { unmount } = render(
      <AboutWindow
        onClose={vi.fn()}
        onPainted={vi.fn().mockResolvedValue(undefined)}
        listenFn={vi.fn().mockResolvedValue(unlisten)}
      />,
    );
    await waitFor(() => expect(unlisten).not.toHaveBeenCalled());
    unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("traps Tab focus inside the dialog", () => {
    render(<AboutWindow onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: /about cairn/i });
    const buttons = screen.getAllByRole("button");
    const first = buttons[0];
    const last = buttons[buttons.length - 1];

    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});
