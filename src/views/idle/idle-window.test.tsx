import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const resolve = vi.fn().mockResolvedValue(undefined);
const dismiss = vi.fn().mockResolvedValue(undefined);
let prompt: unknown = {
  since: "2026-05-30T10:00:00Z",
  until: "2026-05-30T10:12:00Z",
  durationSeconds: 720,
};

vi.mock("../../lib/use-idle-window", () => ({
  useIdleWindow: () => ({ prompt, resolve, dismiss }),
}));

import { IdleWindow } from "./idle-window";

afterEach(() => {
  vi.clearAllMocks();
  prompt = {
    since: "2026-05-30T10:00:00Z",
    until: "2026-05-30T10:12:00Z",
    durationSeconds: 720,
  };
});

describe("IdleWindow", () => {
  it("renders the four resolution choices", () => {
    render(<IdleWindow />);
    expect(screen.getByRole("dialog", { name: /you were away/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /keep in this session/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /discard, keep tracking/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /discard, start new session/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /discard and stop/i })).toBeTruthy();
  });

  it("maps each button to its idle choice", () => {
    render(<IdleWindow />);
    fireEvent.click(screen.getByRole("button", { name: /discard, keep tracking/i }));
    expect(resolve).toHaveBeenCalledWith("discard-continue");
    fireEvent.click(screen.getByRole("button", { name: /discard, start new session/i }));
    expect(resolve).toHaveBeenCalledWith("new-session");
    fireEvent.click(screen.getByRole("button", { name: /keep in this session/i }));
    expect(resolve).toHaveBeenCalledWith("keep");
    fireEvent.click(screen.getByRole("button", { name: /discard and stop/i }));
    expect(resolve).toHaveBeenCalledWith("discard");
  });

  it("dismisses on the close button and on Escape", () => {
    render(<IdleWindow />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(dismiss).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(dismiss).toHaveBeenCalledTimes(2);
  });

  it("disables the choices until a prompt is loaded", () => {
    prompt = null;
    render(<IdleWindow />);
    expect(
      (screen.getByRole("button", { name: /keep in this session/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
