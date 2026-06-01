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
vi.mock("../../lib/use-task-switch-prompt", () => ({
  useTaskSwitchPrompt: () => ({
    active: null,
    confirm: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

describe("TodayView running-start edit (inside Tauri)", () => {
  type WithInternals = { __TAURI_INTERNALS__?: unknown };

  // A timer that started 2 minutes ago (so editing it back is a past time).
  const startedAt = new Date(Date.now() - 2 * 60_000).toISOString();
  const running: BackendEntry = {
    id: "e1",
    projectId: "p1",
    taskId: null,
    description: "Writing",
    startedAt,
    endedAt: null,
    source: "manual",
    ruleId: null,
  };

  beforeEach(() => {
    (globalThis as WithInternals).__TAURI_INTERNALS__ = {};
    vi.resetModules();
  });
  afterEach(() => {
    delete (globalThis as WithInternals).__TAURI_INTERNALS__;
    vi.clearAllMocks();
  });

  async function renderToday() {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "current_running") return running;
      if (cmd === "list_today") return [running];
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
      if (cmd === "update_entry") return running;
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
        screen.queryByRole("button", { name: /edit start time/i }),
      ).not.toBeNull(),
    );
    return { invoke };
  }

  it("shows the start caption and opens the editor on click", async () => {
    await renderToday();
    fireEvent.click(screen.getByRole("button", { name: /edit start time/i }));
    expect(screen.getByLabelText(/^start time$/i)).toBeTruthy();
  });

  it("commits a valid earlier start via update_entry and closes the editor", async () => {
    const { invoke } = await renderToday();
    fireEvent.click(screen.getByRole("button", { name: /edit start time/i }));
    const input = screen.getByLabelText(/^start time$/i) as HTMLInputElement;
    // 30 minutes before the original start — comfortably in the past.
    const earlier = new Date(Date.now() - 32 * 60_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const local =
      `${earlier.getFullYear()}-${pad(earlier.getMonth() + 1)}-${pad(earlier.getDate())}` +
      `T${pad(earlier.getHours())}:${pad(earlier.getMinutes())}`;
    fireEvent.change(input, { target: { value: local } });
    fireEvent.click(screen.getByRole("button", { name: /set start/i }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "update_entry",
        expect.objectContaining({
          input: expect.objectContaining({
            id: "e1",
            startedAt: expect.any(String),
          }),
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByLabelText(/^start time$/i)).toBeNull(),
    );
  });

  it("rejects a future start with an error and no update", async () => {
    const { invoke } = await renderToday();
    fireEvent.click(screen.getByRole("button", { name: /edit start time/i }));
    const input = screen.getByLabelText(/^start time$/i) as HTMLInputElement;
    const future = new Date(Date.now() + 60 * 60_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const local =
      `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}` +
      `T${pad(future.getHours())}:${pad(future.getMinutes())}`;
    fireEvent.change(input, { target: { value: local } });
    fireEvent.click(screen.getByRole("button", { name: /set start/i }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringMatching(/future/i),
    );
    expect(invoke).not.toHaveBeenCalledWith("update_entry", expect.anything());
  });

  it("cancel closes the editor without updating", async () => {
    const { invoke } = await renderToday();
    fireEvent.click(screen.getByRole("button", { name: /edit start time/i }));
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(screen.queryByLabelText(/^start time$/i)).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("update_entry", expect.anything());
  });
});
