import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

const attributeEntryToRemoteTask = vi.fn();
vi.mock("../../lib/ipc", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/ipc")>("../../lib/ipc");
  return {
    ...actual,
    attributeEntryToRemoteTask: (...a: unknown[]) =>
      attributeEntryToRemoteTask(...a),
  };
});

// useToday's create resolves a fixture entry so handleSubmit can chain the
// attribution onto a real id without a backend.
const create = vi.fn();
const update = vi.fn();
const refresh = vi.fn().mockResolvedValue(undefined);
vi.mock("../../lib/use-today", () => ({
  useToday: () => ({
    entries: [],
    loading: false,
    error: null,
    refresh,
    create,
    update,
    remove: vi.fn(),
  }),
}));

// Drive handleSubmit directly with a controllable payload, bypassing the
// real modal/picker (covered in their own suites).
const payload = vi.hoisted(() => ({
  current: {
    id: undefined as string | undefined,
    projectId: null,
    taskId: null,
    description: "work",
    startedAt: "2026-05-26T09:00:00Z",
    endedAt: "2026-05-26T10:00:00Z",
    remoteTask: {
      connectorId: "gh",
      remoteId: "42",
      label: "Fix bug",
      url: "https://gh/42",
      remoteProjectName: "Acme",
    } as unknown,
  },
}));
vi.mock("./manual-entry-modal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./manual-entry-modal")>();
  return {
    ...actual,
    ManualEntryModal: ({
      onSubmit,
    }: {
      onSubmit: (p: unknown) => Promise<void>;
    }) => (
      <button type="button" onClick={() => void onSubmit(payload.current)}>
        mock-submit
      </button>
    ),
  };
});

import { TodayView } from "./index";
import { linkRemoteTask } from "./today";

afterEach(() => {
  vi.clearAllMocks();
  payload.current.id = undefined;
  payload.current.remoteTask = {
    connectorId: "gh",
    remoteId: "42",
    label: "Fix bug",
    url: "https://gh/42",
    remoteProjectName: "Acme",
  };
});

function open() {
  return render(
    <TodayView
      density="comfy"
      layoutVariant="default"
      onOpenRule={vi.fn()}
      addEntryRequest={1}
    />,
  );
}

describe("TodayView — remote-task attribution (#110)", () => {
  it("attributes the created entry to the picked connector task", async () => {
    create.mockResolvedValue({ id: "e1" });
    attributeEntryToRemoteTask.mockResolvedValue({});
    open();
    fireEvent.click(await screen.findByRole("button", { name: "mock-submit" }));

    await waitFor(() =>
      expect(attributeEntryToRemoteTask).toHaveBeenCalledWith({
        entryId: "e1",
        connectorId: "gh",
        remoteId: "42",
        label: "Fix bug",
        url: "https://gh/42",
        remoteProjectName: "Acme",
      }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("surfaces a banner (and keeps the entry) when linking fails", async () => {
    create.mockResolvedValue({ id: "e1" });
    attributeEntryToRemoteTask.mockRejectedValue(new Error("connector down"));
    open();
    fireEvent.click(await screen.findByRole("button", { name: "mock-submit" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("linking the task failed");
    expect(alert.textContent).toContain("connector down");
    // The entry was still created; refresh ran to reflect it.
    expect(create).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalled();
  });

  it("attributes an edited (updated) entry to the picked task", async () => {
    payload.current.id = "e9";
    update.mockResolvedValue({ id: "e9" });
    attributeEntryToRemoteTask.mockResolvedValue({});
    open();
    fireEvent.click(await screen.findByRole("button", { name: "mock-submit" }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(attributeEntryToRemoteTask).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: "e9" }),
    );
  });
});

// The attribution branching lives in a directly-callable helper so both arms
// (picked / not picked, success / failure) are covered deterministically,
// without racing React's async submit flow.
describe("linkRemoteTask (#110)", () => {
  const task = {
    connectorId: "gh",
    remoteId: "42",
    label: "Fix bug",
    url: "https://gh/42",
    remoteProjectName: "Acme",
  };

  it("is a no-op when nothing was picked (no attribute, no refresh)", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    expect(await linkRemoteTask(null, "e1", refresh)).toBeNull();
    expect(attributeEntryToRemoteTask).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("attributes and refreshes on success, returning null", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    attributeEntryToRemoteTask.mockResolvedValue({});
    expect(await linkRemoteTask(task, "e1", refresh)).toBeNull();
    expect(attributeEntryToRemoteTask).toHaveBeenCalledWith({
      entryId: "e1",
      ...task,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("returns an Error message and still refreshes on failure", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    attributeEntryToRemoteTask.mockRejectedValue(new Error("connector down"));
    const err = await linkRemoteTask(task, "e1", refresh);
    expect(err).toContain("linking the task failed");
    expect(err).toContain("connector down");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("stringifies a non-Error rejection", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    attributeEntryToRemoteTask.mockRejectedValue("offline");
    expect(await linkRemoteTask(task, "e1", refresh)).toContain("offline");
  });
});
