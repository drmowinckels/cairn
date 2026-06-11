import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../../lib/use-suggestion", () => ({
  useSuggestion: () => ({
    suggestion: null,
    confirm: vi.fn(),
    dismiss: vi.fn(),
  }),
}));
vi.mock("../../lib/use-task-switch-prompt", () => ({
  useTaskSwitchPrompt: () => ({
    active: null,
    confirm: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

describe("TodayView idle project picker", () => {
  type WithInternals = { __TAURI_INTERNALS__?: unknown };

  beforeEach(() => {
    (globalThis as WithInternals).__TAURI_INTERNALS__ = {};
    vi.resetModules();
  });
  afterEach(() => {
    delete (globalThis as WithInternals).__TAURI_INTERNALS__;
    vi.clearAllMocks();
  });

  async function renderIdle() {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "current_running") return null;
      if (cmd === "list_day") return [];
      if (cmd === "list_projects")
        return [
          {
            id: "p1",
            name: "Cairn",
            clientId: null,
            color: "#abc",
            archived: false,
          },
        ];
      return null;
    });
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    const { TodayView } = await import("./today");
    render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /choose a project/i }),
      ).not.toBeNull(),
    );
    return { invoke };
  }

  it("picks a project from the idle row, updating the chip and closing the menu", async () => {
    await renderIdle();
    fireEvent.click(screen.getByRole("button", { name: /choose a project/i }));
    fireEvent.click(screen.getByRole("button", { name: /^cairn$/i }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: /project: cairn\. change project/i,
        }),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
