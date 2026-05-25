import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// The popover transitively mounts Reports / Settings which both call
// useBackup, which dynamically imports the dialog + opener plugins.
// Mock at the top level so the module factory wins over the consumer
// imports.
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

// The popover transitively mounts Today which renders the
// suggestion banner via useSuggestion(). Mock the hook with a
// fixed Suggestive match so the "view rule" / dismissal flows
// have something to click on.
vi.mock("../../lib/use-suggestion", () => ({
  useSuggestion: () => ({
    suggestion: {
      ruleId: "r1",
      ruleName: "Cairn dev",
      confidence: "suggestive" as const,
      project: "cairn",
      tags: ["dev"],
    },
    confirm: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

import { Popover } from "./popover";

beforeEach(() => {
  document.body.removeAttribute("data-theme");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Popover shell", () => {
  it("renders dialog landmarks: header, nav, body, footer", () => {
    render(<Popover />);
    expect(
      screen.getByRole("dialog", { name: /cairn time tracker/i }),
    ).toBeTruthy();
    expect(screen.getByRole("tablist", { name: /cairn views/i })).toBeTruthy();
    expect(screen.getByRole("tabpanel")).toBeTruthy();
  });

  it("renders all four tabs with the right active state", () => {
    render(<Popover initialView="reports" />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(4);
    const labels = tabs.map((t) => t.textContent?.trim());
    expect(labels).toEqual([
      expect.stringMatching(/today/i),
      expect.stringMatching(/reports/i),
      expect.stringMatching(/rules/i),
      expect.stringMatching(/settings/i),
    ]);
    const reportsTab = tabs.find((t) => /reports/i.test(t.textContent ?? ""))!;
    expect(reportsTab.getAttribute("aria-selected")).toBe("true");
  });

  it("clicking a tab switches the active view", () => {
    render(<Popover />);
    const rulesTab = screen
      .getAllByRole("tab")
      .find((t) => /rules/i.test(t.textContent ?? ""))!;
    fireEvent.click(rulesTab);
    expect(rulesTab.getAttribute("aria-selected")).toBe("true");
    // Rules view landmark
    expect(screen.getByRole("heading", { name: /^rules$/i })).toBeTruthy();
  });

  it("keyboard shortcuts 1-4 switch views (outside input/textarea)", () => {
    render(<Popover />);
    fireEvent.keyDown(window, { key: "2" });
    expect(screen.getByRole("heading", { name: /this week/i })).toBeTruthy();
    fireEvent.keyDown(window, { key: "3" });
    expect(screen.getByRole("heading", { name: /^rules$/i })).toBeTruthy();
    fireEvent.keyDown(window, { key: "4" });
    expect(screen.getByRole("heading", { name: /your data stays here/i })).toBeTruthy();
    fireEvent.keyDown(window, { key: "1" });
    // Today view doesn't have a heading-level title, so check the timeline label.
    expect(screen.getByText(/today's path/i)).toBeTruthy();
  });

  it("keyboard shortcut is ignored when an INPUT has focus", () => {
    render(<Popover />);
    // Focus the task-description input inside the running-timer card.
    const input = screen.getByLabelText(/task description/i) as HTMLInputElement;
    input.focus();
    fireEvent.keyDown(input, { key: "3" });
    // Still on Today
    expect(screen.getByText(/today's path/i)).toBeTruthy();
  });

  it("sets the data-theme attribute when theme prop is explicit", () => {
    const { rerender, unmount } = render(<Popover theme="dark" />);
    expect(document.body.dataset.theme).toBe("dark");
    rerender(<Popover theme="light" />);
    expect(document.body.dataset.theme).toBe("light");
    // system theme removes the attribute entirely.
    rerender(<Popover theme="system" />);
    expect(document.body.dataset.theme).toBeUndefined();
    unmount();
  });

  it("renders the LocalBadge in the header with the privacy tooltip", () => {
    render(<Popover />);
    const badge = document.querySelector(".local-badge");
    expect(badge?.getAttribute("title")).toContain("stays on your machine");
  });

  it("opens the rules view with the matching rule expanded when 'view rule' is clicked from a suggestion", () => {
    render(<Popover />);
    const link = screen.getByRole("button", { name: /view rule/i });
    fireEvent.click(link);
    expect(screen.getByRole("heading", { name: /^rules$/i })).toBeTruthy();
  });
});

describe("Density propagation", () => {
  it("applies data-density on the root popover", () => {
    const { container, rerender } = render(<Popover density="compact" />);
    expect(container.querySelector(".pop")?.getAttribute("data-density")).toBe(
      "compact",
    );
    rerender(<Popover density="comfy" />);
    expect(container.querySelector(".pop")?.getAttribute("data-density")).toBe(
      "comfy",
    );
  });
});
