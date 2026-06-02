import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

import { AboutWindow } from "./about-window";

beforeEach(() => {
  localStorage.clear();
  for (const key of Object.keys(document.documentElement.dataset)) {
    delete document.documentElement.dataset[key];
  }
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
