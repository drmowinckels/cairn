import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

const REMOTE_ENTRY = {
  id: "e1",
  projectId: null,
  taskId: "t-remote",
  description: "remote work",
  startedAt: "2026-05-26T09:00:00Z",
  endedAt: "2026-05-26T10:00:00Z",
  source: "manual",
  ruleId: null,
};
const PLAIN_ENTRY = {
  id: "e2",
  projectId: "cairn",
  taskId: null,
  description: "plain work",
  startedAt: "2026-05-26T08:00:00Z",
  endedAt: "2026-05-26T08:30:00Z",
  source: "manual",
  ruleId: null,
};

vi.mock("../../lib/use-today", () => ({
  useToday: () => ({
    entries: [REMOTE_ENTRY, PLAIN_ENTRY],
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  }),
}));

const REMOTE_TASK = {
  id: "t-remote",
  projectId: null,
  name: "Fix bug",
  archived: false,
  connectorId: "gh",
  remoteId: "42",
  remoteUrl: "https://gh/42",
  remoteProjectName: "Acme",
};
vi.mock("../../lib/use-tasks", () => ({
  useTaskMap: () => ({
    byId: { "t-remote": REMOTE_TASK },
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}));

// Capture what openEdit seeds into the modal.
const modalInitial = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./manual-entry-modal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./manual-entry-modal")>();
  return {
    ...actual,
    ManualEntryModal: ({ initial }: { initial: unknown }) => {
      modalInitial.current = initial;
      return <div data-testid="modal" />;
    },
  };
});

import { TodayView } from "./index";
import { draftFromEntry, remoteTaskOf } from "./today";

afterEach(() => {
  vi.clearAllMocks();
  modalInitial.current = null;
});

describe("TodayView — remote-task display (#110)", () => {
  it("shows the chip only on the remote-attributed row", () => {
    render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
      />,
    );
    const chips = document.querySelectorAll(".entry-remote");
    expect(chips.length).toBe(1);
    expect(chips[0].textContent).toContain("Fix bug");
  });

  it("seeds the editor's remote-task link when editing a linked entry", () => {
    render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /edit entry:.*remote work/i }),
    );
    expect(screen.getByTestId("modal")).toBeTruthy();
    expect(
      (modalInitial.current as { remoteTask?: unknown }).remoteTask,
    ).toEqual({
      connectorId: "gh",
      remoteId: "42",
      label: "Fix bug",
      url: "https://gh/42",
      remoteProjectName: "Acme",
    });
  });

  it("seeds null when editing an unlinked entry", () => {
    render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /edit entry:.*plain work/i }),
    );
    expect(
      (modalInitial.current as { remoteTask?: unknown }).remoteTask,
    ).toBeNull();
  });
});

describe("draftFromEntry", () => {
  it("seeds a closed, remote-linked entry", () => {
    const draft = draftFromEntry(REMOTE_ENTRY, { "t-remote": REMOTE_TASK });
    expect(draft.endedLocal).not.toBe("");
    expect(draft.remoteTask).toEqual(remoteTaskOf(REMOTE_TASK));
  });

  it("seeds a running (open) entry with an empty end and no link", () => {
    const draft = draftFromEntry({ ...PLAIN_ENTRY, endedAt: null }, {});
    expect(draft.endedLocal).toBe("");
    expect(draft.remoteTask).toBeNull();
  });
});

describe("remoteTaskOf", () => {
  it("returns null for an absent or local task", () => {
    expect(remoteTaskOf(undefined)).toBeNull();
    expect(
      remoteTaskOf({
        id: "t1",
        projectId: "p1",
        name: "Local",
        archived: false,
      }),
    ).toBeNull();
  });

  it("builds a picked-task from a remote task, defaulting null url/project", () => {
    expect(remoteTaskOf(REMOTE_TASK)).toEqual({
      connectorId: "gh",
      remoteId: "42",
      label: "Fix bug",
      url: "https://gh/42",
      remoteProjectName: "Acme",
    });
    expect(
      remoteTaskOf({
        id: "t2",
        projectId: null,
        name: "Bare",
        archived: false,
        connectorId: "gh",
        remoteId: "9",
      }),
    ).toEqual({
      connectorId: "gh",
      remoteId: "9",
      label: "Bare",
      url: null,
      remoteProjectName: null,
    });
  });
});
