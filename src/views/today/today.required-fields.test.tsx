import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BackendEntry } from "../../lib/ipc";

vi.mock("../../lib/use-suggestion", () => ({
  useSuggestion: () => ({
    suggestion: null,
    confirm: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

describe("TodayView required-fields gate (inside Tauri)", () => {
  type WithInternals = { __TAURI_INTERNALS__?: unknown };

  beforeEach(() => {
    (globalThis as WithInternals).__TAURI_INTERNALS__ = {};
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as WithInternals).__TAURI_INTERNALS__;
    vi.clearAllMocks();
  });

  const baseRunning: BackendEntry = {
    id: "e1",
    projectId: "p1",
    taskId: null,
    description: "something",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    endedAt: null,
    source: "manual",
    ruleId: null,
  };

  async function freshRender(
    running: BackendEntry,
    requiredFields: { requireProject: boolean; requireDescription: boolean },
  ) {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "current_running") return running;
      if (cmd === "list_day") return [running];
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
      if (cmd === "stop_entry")
        return { ...running, endedAt: new Date().toISOString() };
      return null;
    });
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    const { TodayView } = await import("./today");
    const utils = render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
        requiredFields={requiredFields}
      />,
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /stop timer/i }),
      ).not.toBeNull(),
    );
    return { ...utils, invoke };
  }

  describe("both prefs off (default)", () => {
    it("stop proceeds immediately with no error shown", async () => {
      const { invoke } = await freshRender(baseRunning, {
        requireProject: false,
        requireDescription: false,
      });
      fireEvent.click(screen.getByRole("button", { name: /stop timer/i }));
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("stop_entry", { id: "e1" }),
      );
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  describe("require project only", () => {
    it("blocks stop and shows error when project is null", async () => {
      const { invoke } = await freshRender(
        { ...baseRunning, projectId: null },
        { requireProject: true, requireDescription: false },
      );
      fireEvent.click(screen.getByRole("button", { name: /stop timer/i }));
      expect(invoke).not.toHaveBeenCalledWith("stop_entry", expect.anything());
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(/choose a project/i);
    });

    it("does not block stop when project is set", async () => {
      const { invoke } = await freshRender(baseRunning, {
        requireProject: true,
        requireDescription: false,
      });
      fireEvent.click(screen.getByRole("button", { name: /stop timer/i }));
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("stop_entry", { id: "e1" }),
      );
    });

    it("marks the project picker chip as aria-invalid when blocked", async () => {
      await freshRender(
        { ...baseRunning, projectId: null },
        { requireProject: true, requireDescription: false },
      );
      fireEvent.click(screen.getByRole("button", { name: /stop timer/i }));
      const chip = await screen.findByRole("button", {
        name: /choose a project/i,
      });
      expect(chip.getAttribute("aria-invalid")).toBe("true");
    });
  });

  describe("require description only", () => {
    it("blocks stop and shows error when description is empty", async () => {
      const { invoke } = await freshRender(
        { ...baseRunning, description: "" },
        { requireProject: false, requireDescription: true },
      );
      fireEvent.click(screen.getByRole("button", { name: /stop timer/i }));
      expect(invoke).not.toHaveBeenCalledWith("stop_entry", expect.anything());
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(/add a description/i);
    });

    it("does not block stop when description is non-empty", async () => {
      const { invoke } = await freshRender(baseRunning, {
        requireProject: false,
        requireDescription: true,
      });
      fireEvent.click(screen.getByRole("button", { name: /stop timer/i }));
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("stop_entry", { id: "e1" }),
      );
    });

    it("marks the description input as aria-invalid when blocked", async () => {
      await freshRender(
        { ...baseRunning, description: "" },
        { requireProject: false, requireDescription: true },
      );
      fireEvent.click(screen.getByRole("button", { name: /stop timer/i }));
      const input = screen.getByRole("textbox", { name: /task description/i });
      await waitFor(() =>
        expect(input.getAttribute("aria-invalid")).toBe("true"),
      );
    });

    it("auto-clears the block once the requirement is satisfied", async () => {
      const { rerender } = await freshRender(
        { ...baseRunning, description: "" },
        { requireProject: false, requireDescription: true },
      );
      fireEvent.click(screen.getByRole("button", { name: /stop timer/i }));
      await screen.findByRole("alert");
      // Relaxing the requirement makes canStop() true → the effect clears it.
      const { TodayView } = await import("./today");
      rerender(
        <TodayView
          density="comfy"
          layoutVariant="default"
          onOpenRule={vi.fn()}
          requiredFields={{ requireProject: false, requireDescription: false }}
        />,
      );
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    });
  });

  describe("both prefs on", () => {
    it("shows combined error when both project and description are missing", async () => {
      const { invoke } = await freshRender(
        { ...baseRunning, projectId: null, description: "" },
        { requireProject: true, requireDescription: true },
      );
      fireEvent.click(screen.getByRole("button", { name: /stop timer/i }));
      expect(invoke).not.toHaveBeenCalledWith("stop_entry", expect.anything());
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(/add a project and description/i);
    });

    it("does not block when both fields are filled", async () => {
      const { invoke } = await freshRender(baseRunning, {
        requireProject: true,
        requireDescription: true,
      });
      fireEvent.click(screen.getByRole("button", { name: /stop timer/i }));
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("stop_entry", { id: "e1" }),
      );
    });
  });
});
