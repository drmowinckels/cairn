import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BackendEntry } from "../../lib/ipc";

vi.mock("../../lib/use-suggestion", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/use-suggestion")>();
  return {
    ...actual,
    useSuggestion: () => ({
      suggestion: null,
      confirm: vi.fn(),
      dismiss: vi.fn(),
    }),
  };
});
vi.mock("../../lib/use-task-switch-prompt", () => ({
  useTaskSwitchPrompt: () => ({
    active: null,
    confirm: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

/**
 * Set the running-start editor's date and time halves (#308). The editor is
 * two controls now, not one `datetime-local` box, and each commits on blur.
 * The date field accepts an ISO date whatever the user's chosen field order.
 */
function setStartDateTime(when: Date): void {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = screen.getByLabelText(/^start date$/i);
  fireEvent.change(date, {
    target: {
      value: `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`,
    },
  });
  fireEvent.blur(date);
  const time = screen.getByLabelText(/^start time$/i);
  fireEvent.change(time, {
    target: { value: `${pad(when.getHours())}:${pad(when.getMinutes())}` },
  });
  fireEvent.blur(time);
}

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

  async function renderToday(opts: { updateRejects?: boolean } = {}) {
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
      if (cmd === "update_entry") {
        if (opts.updateRejects) throw new Error("db locked");
        return running;
      }
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
    // 30 minutes before the original start — comfortably in the past.
    const earlier = new Date(Date.now() - 32 * 60_000);
    setStartDateTime(earlier);
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
    const future = new Date(Date.now() + 60 * 60_000);
    setStartDateTime(future);
    fireEvent.click(screen.getByRole("button", { name: /set start/i }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringMatching(/future/i),
    );
    expect(invoke).not.toHaveBeenCalledWith("update_entry", expect.anything());
  });

  it("swallows an update_entry rejection (still closes)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await renderToday({ updateRejects: true });
    fireEvent.click(screen.getByRole("button", { name: /edit start time/i }));
    const earlier = new Date(Date.now() - 32 * 60_000);
    setStartDateTime(earlier);
    fireEvent.click(screen.getByRole("button", { name: /set start/i }));
    await waitFor(() => expect(err).toHaveBeenCalled());
    expect(screen.queryByLabelText(/^start time$/i)).toBeNull();
    err.mockRestore();
  });

  it("cancel closes the editor without updating", async () => {
    const { invoke } = await renderToday();
    fireEvent.click(screen.getByRole("button", { name: /edit start time/i }));
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(screen.queryByLabelText(/^start time$/i)).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("update_entry", expect.anything());
  });
});
