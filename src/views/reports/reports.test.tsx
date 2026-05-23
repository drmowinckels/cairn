import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn(),
}));

import { ReportsView } from "./index";

const writeText = vi.fn();

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  writeText.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ReportsView", () => {
  it("renders the week title, label, and totals", () => {
    render(<ReportsView density="comfy" />);
    expect(screen.getByRole("heading", { name: /this week/i })).toBeTruthy();
    expect(screen.getByText(/may 18 — may 24, 2026/i)).toBeTruthy();
    expect(screen.getByText(/tracked/i)).toBeTruthy();
    expect(screen.getByText(/daily avg/i)).toBeTruthy();
    expect(screen.getByText(/projects/i)).toBeTruthy();
  });

  it("renders the Day/Week/Month segmented control with Week active", () => {
    render(<ReportsView density="comfy" />);
    const seg = screen.getByRole("tablist", { name: /period/i });
    const buttons = seg.querySelectorAll("button");
    expect(buttons).toHaveLength(3);
    const week = Array.from(buttons).find(
      (b) => b.textContent?.trim() === "Week",
    )!;
    expect(week.getAttribute("aria-selected")).toBe("true");
  });

  it("renders one stacked bar per weekday", () => {
    const { container } = render(<ReportsView density="comfy" />);
    expect(container.querySelectorAll(".bar-col").length).toBe(7);
  });

  it("renders a 'By project' breakdown sorted by hours", () => {
    const { container } = render(<ReportsView density="comfy" />);
    expect(screen.getByLabelText(/project breakdown/i)).toBeTruthy();
    const rows = container.querySelectorAll(".bd-row");
    expect(rows.length).toBeGreaterThan(0);
  });

  it("'Copy summary' writes a summary to the clipboard and flips the label to 'Copied ✓'", async () => {
    writeText.mockResolvedValue(undefined);
    render(<ReportsView density="comfy" />);
    fireEvent.click(screen.getByRole("button", { name: /copy summary/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0]?.[0]).toMatch(/may 18 — may 24, 2026/i);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /copied/i })).toBeTruthy(),
    );
  });

  it("'Copy summary' tolerates a clipboard rejection", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeText.mockRejectedValue(new Error("no clipboard"));
    render(<ReportsView density="comfy" />);
    fireEvent.click(screen.getByRole("button", { name: /copy summary/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
