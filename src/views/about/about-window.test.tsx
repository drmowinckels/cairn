import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

import { AboutWindow } from "./about-window";

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
});
