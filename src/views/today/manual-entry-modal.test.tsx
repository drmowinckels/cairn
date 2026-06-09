import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

const openUrl = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...a: unknown[]) => openUrl(...a),
}));

// Isolate the modal from the picker's connector drill (covered in
// remote-task-picker.test.tsx): a stub button reports a pick whose URL the
// test can vary to exercise the safe/unsafe deep-link branch.
const picked = vi.hoisted(() => ({ url: "https://gh/42" as string | null }));
vi.mock("./remote-task-picker", () => ({
  RemoteTaskPicker: ({
    onPick,
    onCancel,
  }: {
    onPick: (p: unknown) => void;
    onCancel: () => void;
  }) => (
    <>
      <button
        type="button"
        onClick={() =>
          onPick({
            connectorId: "gh",
            remoteId: "42",
            label: "Fix bug",
            url: picked.url,
            remoteProjectName: "Acme",
          })
        }
      >
        mock-pick
      </button>
      <button type="button" onClick={onCancel}>
        mock-cancel
      </button>
    </>
  ),
}));

const GH_CONNECTOR: Connector = {
  id: "gh",
  name: "GitHub Projects",
  capabilities: [],
  kind: { http: { baseUrl: "https://api.github.com" } },
  secret: "set",
  enabled: true,
};

import {
  ManualEntryModal,
  isoToLocal,
  localToIso,
  validateDraft,
  type ManualEntryDraft,
  type ManualEntrySubmit,
} from "./manual-entry-modal";
import type { Project, Task } from "../../lib/types";
import type { Connector } from "../../lib/ipc";

const PROJECTS: Project[] = [
  {
    id: "p1",
    name: "Alpha",
    clientId: null,
    color: "#aaa",
    archived: false,
    estimateHours: null,
  },
  {
    id: "p2",
    name: "Beta",
    clientId: null,
    color: "#bbb",
    archived: false,
    estimateHours: null,
  },
];

const TASKS_P1: Task[] = [
  { id: "t1", projectId: "p1", name: "Design", archived: false },
  { id: "t2", projectId: "p1", name: "Build", archived: false },
];

const BASE_DRAFT: ManualEntryDraft = {
  projectId: null,
  taskId: null,
  description: "",
  startedLocal: "2026-05-26T09:00",
  endedLocal: "2026-05-26T10:00",
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("ManualEntryModal — render & a11y", () => {
  it("renders as a dialog with aria-modal=true", () => {
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={BASE_DRAFT}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: /new entry/i });
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("returns null when open=false", () => {
    const { container } = render(
      <ManualEntryModal
        open={false}
        mode="create"
        initial={BASE_DRAFT}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("calls onClose when Escape is pressed inside the dialog", () => {
    const onClose = vi.fn();
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={BASE_DRAFT}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the overlay is clicked", () => {
    const onClose = vi.fn();
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={BASE_DRAFT}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        onClose={onClose}
      />,
    );
    const overlay = document.querySelector(".modal-overlay") as HTMLElement;
    fireEvent.mouseDown(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("mousedown on the dialog (inside the overlay) does not close the modal", () => {
    const onClose = vi.fn();
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={BASE_DRAFT}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        onClose={onClose}
      />,
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.mouseDown(dialog);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Tab on the last focusable wraps to the first (focus trap)", async () => {
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={BASE_DRAFT}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    const focusables = dialog.querySelectorAll<HTMLElement>(
      'button, input, select, [tabindex]:not([tabindex="-1"])',
    );
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    // jsdom doesn't honor preventDefault on programmatic events,
    // but our handler also calls .focus() on `first` when wrapping.
    await waitFor(() => expect(document.activeElement).toBe(first));
  });

  it("Shift+Tab on the first focusable wraps to the last (focus trap)", async () => {
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={BASE_DRAFT}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    const focusables = dialog.querySelectorAll<HTMLElement>(
      'button, input, select, [tabindex]:not([tabindex="-1"])',
    );
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    first.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    await waitFor(() => expect(document.activeElement).toBe(last));
  });

  it("non-Tab/non-Escape keydown inside the dialog is a no-op", () => {
    const onClose = vi.fn();
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={BASE_DRAFT}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        onClose={onClose}
      />,
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Tab from a middle focusable does NOT wrap (focus trap only wraps at edges)", () => {
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={BASE_DRAFT}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    const focusables = dialog.querySelectorAll<HTMLElement>(
      'button, input, select, [tabindex]:not([tabindex="-1"])',
    );
    const middle = focusables[Math.floor(focusables.length / 2)];
    middle.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(middle);
  });
});

describe("ManualEntryModal — validation", () => {
  it("submit button is disabled when start time is empty", () => {
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={{ ...BASE_DRAFT, startedLocal: "" }}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const save = screen.getByRole("button", { name: /save/i });
    expect(save.hasAttribute("disabled")).toBe(true);
  });

  it("submit is disabled when end <= start", () => {
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={{
          ...BASE_DRAFT,
          startedLocal: "2026-05-26T10:00",
          endedLocal: "2026-05-26T09:00",
        }}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const save = screen.getByRole("button", { name: /save/i });
    expect(save.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/end must be after start/i)).toBeTruthy();
  });

  it("submit is enabled with valid range; calls onSubmit with UTC ISO timestamps", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={{
          ...BASE_DRAFT,
          description: "  Backfill  ",
          projectId: "p1",
        }}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    );
    const save = screen.getByRole("button", { name: /save/i });
    expect(save.hasAttribute("disabled")).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0] as ManualEntrySubmit;
    expect(payload.description).toBe("Backfill");
    expect(payload.projectId).toBe("p1");
    // Verify ISO 8601 UTC suffix.
    expect(payload.startedAt).toMatch(/Z$/);
    expect(payload.endedAt).toMatch(/Z$/);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("submits with endedAt=null when the end field is empty (running)", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={{ ...BASE_DRAFT, endedLocal: "" }}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const payload = onSubmit.mock.calls[0][0] as ManualEntrySubmit;
    expect(payload.endedAt).toBeNull();
  });

  it("overlap with running timer renders a warning but allows submit", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    // The running timer started 1h ago; the draft starts 30 min ago
    // and ends 5 min ago — guaranteed overlap regardless of test
    // runtime clock.
    const runningStartIso = new Date(Date.now() - 60 * 60_000).toISOString();
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={{
          ...BASE_DRAFT,
          startedLocal: isoToLocal(
            new Date(Date.now() - 30 * 60_000).toISOString(),
          ),
          endedLocal: isoToLocal(
            new Date(Date.now() - 5 * 60_000).toISOString(),
          ),
        }}
        projects={PROJECTS}
        runningRange={{ id: "running-id", startedAt: runningStartIso }}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/overlaps with the currently-running timer/i),
    ).toBeTruthy();
    const save = screen.getByRole("button", { name: /save/i });
    expect(save.hasAttribute("disabled")).toBe(false);
  });

  it("surfaces a submit error if onSubmit rejects, keeping the modal open", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("ipc unavailable"));
    const onClose = vi.fn();
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={BASE_DRAFT}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(screen.getByText(/ipc unavailable/i)).toBeTruthy(),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("ManualEntryModal — edit mode + delete", () => {
  const EDIT_DRAFT: ManualEntryDraft = {
    id: "entry-1",
    projectId: "p1",
    taskId: null,
    description: "Existing work",
    startedLocal: "2026-05-26T09:00",
    endedLocal: "2026-05-26T10:00",
  };

  it("titles the modal 'Edit entry' in edit mode", () => {
    render(
      <ManualEntryModal
        open
        mode="edit"
        initial={EDIT_DRAFT}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog", { name: /edit entry/i })).toBeTruthy();
  });

  it("prefills the form fields from the initial draft", () => {
    render(
      <ManualEntryModal
        open
        mode="edit"
        initial={EDIT_DRAFT}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const desc = screen.getByLabelText(/description/i) as HTMLInputElement;
    expect(desc.value).toBe("Existing work");
    const project = screen.getByLabelText(/project/i) as HTMLSelectElement;
    expect(project.value).toBe("p1");
  });

  it("delete requires a confirm step before calling onDelete", async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(
      <ManualEntryModal
        open
        mode="edit"
        initial={EDIT_DRAFT}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        onDelete={onDelete}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    // Confirm step appears.
    const confirmBtn = screen.getByRole("button", { name: /^delete$/i });
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("entry-1"));
  });

  it("cancel inside the confirm step returns to the default footer", () => {
    render(
      <ManualEntryModal
        open
        mode="edit"
        initial={EDIT_DRAFT}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    expect(screen.getByText(/delete this entry/i)).toBeTruthy();
    // Click the confirm-row's Cancel (its parent has class .confirm-row).
    const confirmCancel = document.querySelector(
      ".confirm-row button.btn--ghost",
    ) as HTMLElement;
    expect(confirmCancel).not.toBeNull();
    fireEvent.click(confirmCancel);
    expect(screen.queryByText(/delete this entry/i)).toBeNull();
    expect(screen.getByRole("button", { name: /^delete$/i })).toBeTruthy();
  });
});

describe("validateDraft (pure)", () => {
  it("rejects empty start", () => {
    const v = validateDraft({ ...BASE_DRAFT, startedLocal: "" }, null);
    expect(v.ok).toBe(false);
  });
  it("rejects a non-empty but unparseable start (localToIso yields '')", () => {
    const v = validateDraft(
      { ...BASE_DRAFT, startedLocal: "garbage", endedLocal: "" },
      null,
    );
    expect(v.ok).toBe(false);
    expect(v.startError).toBe("Start time is required.");
  });
  it("rejects equal start/end", () => {
    const v = validateDraft(
      {
        ...BASE_DRAFT,
        startedLocal: "2026-05-26T09:00",
        endedLocal: "2026-05-26T09:00",
      },
      null,
    );
    expect(v.ok).toBe(false);
  });
  it("accepts open-ended (no end)", () => {
    const v = validateDraft({ ...BASE_DRAFT, endedLocal: "" }, null);
    expect(v.ok).toBe(true);
  });
  it("does not flag overlap when editing the same running entry", () => {
    const v = validateDraft(
      { ...BASE_DRAFT, id: "r1" },
      { id: "r1", startedAt: "2026-05-26T08:30:00Z" },
    );
    expect(v.overlapWarning).toBeNull();
  });
  it("flags overlap when a closed draft intersects the running entry", () => {
    const now = new Date();
    const tenMinAgo = new Date(now.getTime() - 10 * 60_000);
    const fiveMinAhead = new Date(now.getTime() + 5 * 60_000);
    const v = validateDraft(
      {
        ...BASE_DRAFT,
        startedLocal: toLocal(tenMinAgo),
        endedLocal: toLocal(fiveMinAhead),
      },
      {
        id: "running",
        startedAt: new Date(now.getTime() - 30 * 60_000).toISOString(),
      },
    );
    expect(v.overlapWarning).toMatch(/overlaps/i);
  });
  it("does not flag overlap for an open-ended draft (it supersedes the timer)", () => {
    const v = validateDraft(
      { ...BASE_DRAFT, endedLocal: "" },
      {
        id: "running",
        startedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      },
    );
    expect(v.overlapWarning).toBeNull();
  });
});

function toLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

describe("ManualEntryModal — field changes & focus return", () => {
  it("typing into the description, project, start and end fields updates the draft", () => {
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={{
          ...BASE_DRAFT,
          startedLocal: "2026-05-26T09:00",
          endedLocal: "",
        }}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const desc = screen.getByLabelText(/description/i) as HTMLInputElement;
    fireEvent.change(desc, { target: { value: "Triage" } });
    expect(desc.value).toBe("Triage");

    const project = screen.getByLabelText(/project/i) as HTMLSelectElement;
    fireEvent.change(project, { target: { value: "p2" } });
    expect(project.value).toBe("p2");

    // Switching back to "No project" sets projectId to null.
    fireEvent.change(project, { target: { value: "" } });
    expect(project.value).toBe("");

    const start = screen.getByLabelText(/^start/i) as HTMLInputElement;
    fireEvent.change(start, { target: { value: "2026-05-26T10:00" } });
    expect(start.value).toBe("2026-05-26T10:00");

    const end = screen.getByLabelText(/^end/i) as HTMLInputElement;
    fireEvent.change(end, { target: { value: "2026-05-26T11:00" } });
    expect(end.value).toBe("2026-05-26T11:00");
  });

  it("returns focus to the opener element when the modal closes", () => {
    const opener = document.createElement("button");
    opener.textContent = "opener";
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { rerender } = render(
      <ManualEntryModal
        open
        mode="create"
        initial={BASE_DRAFT}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // Closing the modal should restore focus to the opener.
    rerender(
      <ManualEntryModal
        open={false}
        mode="create"
        initial={BASE_DRAFT}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("Shift+Tab on the first focusable wraps to the last (focus trap)", async () => {
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={BASE_DRAFT}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    const focusables = dialog.querySelectorAll<HTMLElement>(
      'button, input, select, [tabindex]:not([tabindex="-1"])',
    );
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    first.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    await waitFor(() => expect(document.activeElement).toBe(last));
  });

  it("surfaces a delete error if onDelete rejects, keeping the modal open", async () => {
    const onDelete = vi.fn().mockRejectedValue(new Error("delete failed"));
    const onClose = vi.fn();
    render(
      <ManualEntryModal
        open
        mode="edit"
        initial={{
          id: "entry-1",
          projectId: "p1",
          taskId: null,
          description: "Existing",
          startedLocal: "2026-05-26T09:00",
          endedLocal: "2026-05-26T10:00",
        }}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        onDelete={onDelete}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    await waitFor(() =>
      expect(screen.getByText(/delete failed/i)).toBeTruthy(),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("localToIso / isoToLocal round-trip", () => {
  it("isoToLocal returns YYYY-MM-DDTHH:MM in local zone", () => {
    const local = isoToLocal("2026-05-26T09:30:00Z");
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it("isoToLocal returns empty for empty / invalid input", () => {
    expect(isoToLocal("")).toBe("");
    expect(isoToLocal("not-a-date")).toBe("");
  });

  it("localToIso returns empty for empty input", () => {
    expect(localToIso("")).toBe("");
  });

  it("localToIso returns empty for unparseable input instead of throwing", () => {
    expect(localToIso("garbage")).toBe("");
  });

  it("localToIso returns an RFC 3339 string for valid input", () => {
    expect(localToIso("2026-05-26T09:30")).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it("localToIso → isoToLocal round-trip preserves the wall-clock components", () => {
    const local = "2026-05-26T09:30";
    const iso = localToIso(local);
    const back = isoToLocal(iso);
    expect(back).toBe(local);
  });
});

describe("ManualEntryModal — inline create project", () => {
  it("hides the New-project affordance when onCreateProject is absent", () => {
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={BASE_DRAFT}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /new project/i })).toBeNull();
  });

  it("reveals the sub-form, creates a project, and selects it on the draft", async () => {
    const created: Project = {
      id: "p-new",
      name: "Gamma",
      clientId: null,
      color: "#81b29a",
      archived: false,
      estimateHours: null,
    };
    const onCreateProject = vi.fn().mockResolvedValue(created);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={BASE_DRAFT}
        projects={[...PROJECTS, created]}
        runningRange={null}
        onSubmit={onSubmit}
        onCreateProject={onCreateProject}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /new project/i }));
    const nameInput = screen.getByLabelText(/new project name/i);
    fireEvent.change(nameInput, { target: { value: "Gamma" } });
    fireEvent.click(screen.getByRole("button", { name: /add project/i }));

    await waitFor(() =>
      expect(onCreateProject).toHaveBeenCalledWith({
        name: "Gamma",
        color: "#81b29a",
      }),
    );
    // Sub-form collapses and the picker reflects the new selection.
    await waitFor(() =>
      expect(screen.queryByLabelText(/new project name/i)).toBeNull(),
    );
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("p-new"));

    // Saving carries the freshly-created project id through.
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "p-new" }),
      ),
    );
  });

  it("blocks creation with a blank name and surfaces an error", async () => {
    const onCreateProject = vi.fn();
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={BASE_DRAFT}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        onCreateProject={onCreateProject}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /new project/i }));
    // The Add button is disabled while the name is blank, so the user
    // can't even trigger creation — assert that and that nothing fired.
    const addBtn = screen.getByRole("button", { name: /add project/i });
    expect((addBtn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(addBtn);
    expect(onCreateProject).not.toHaveBeenCalled();

    // Pressing Enter on a whitespace-only name hits the validation
    // branch and surfaces an inline error rather than calling through.
    const nameInput = screen.getByLabelText(/new project name/i);
    fireEvent.change(nameInput, { target: { value: "   " } });
    fireEvent.keyDown(nameInput, { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/name/i),
    );
    expect(onCreateProject).not.toHaveBeenCalled();
  });

  it("surfaces a backend error when project creation fails", async () => {
    const onCreateProject = vi.fn().mockRejectedValue("disk full");
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={BASE_DRAFT}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        onCreateProject={onCreateProject}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /new project/i }));
    fireEvent.change(screen.getByLabelText(/new project name/i), {
      target: { value: "Gamma" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add project/i }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/disk full/i),
    );
    // Sub-form stays open so the user can retry.
    expect(screen.getByLabelText(/new project name/i)).toBeTruthy();
  });

  it("creates via the Enter key in the name field", async () => {
    const onCreateProject = vi.fn().mockResolvedValue({
      id: "p-enter",
      name: "Epsilon",
      clientId: null,
      color: "#81b29a",
      archived: false,
    });
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={BASE_DRAFT}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        onCreateProject={onCreateProject}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /new project/i }));
    const nameInput = screen.getByLabelText(/new project name/i);
    fireEvent.change(nameInput, { target: { value: "Epsilon" } });
    fireEvent.keyDown(nameInput, { key: "Enter" });
    await waitFor(() =>
      expect(onCreateProject).toHaveBeenCalledWith({
        name: "Epsilon",
        color: "#81b29a",
      }),
    );
  });

  it("picks a color swatch before creating", async () => {
    const onCreateProject = vi.fn().mockResolvedValue({
      id: "p-c",
      name: "Delta",
      clientId: null,
      color: "#e07a5f",
      archived: false,
    });
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={BASE_DRAFT}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        onCreateProject={onCreateProject}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /new project/i }));
    fireEvent.change(screen.getByLabelText(/new project name/i), {
      target: { value: "Delta" },
    });
    // Swatches are labeled by name, not hex (#e07a5f = "Clay").
    fireEvent.click(screen.getByRole("radio", { name: /^clay$/i }));
    fireEvent.click(screen.getByRole("button", { name: /add project/i }));
    await waitFor(() =>
      expect(onCreateProject).toHaveBeenCalledWith({
        name: "Delta",
        color: "#e07a5f",
      }),
    );
  });

  it("labels color swatches by name, not hex code", () => {
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={BASE_DRAFT}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        onCreateProject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /new project/i }));
    const group = screen.getByRole("radiogroup", { name: /project color/i });
    const labels = Array.from(group.querySelectorAll('[role="radio"]')).map(
      (el) => el.getAttribute("aria-label"),
    );
    expect(labels).toEqual(["Sage", "Sand", "Clay", "Slate", "Lilac", "Sky"]);
    // None expose a raw hex string.
    labels.forEach((l) => expect(l).not.toMatch(/#/));
  });

  it("cancel collapses the sub-form without creating", () => {
    const onCreateProject = vi.fn();
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={BASE_DRAFT}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        onCreateProject={onCreateProject}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /new project/i }));
    expect(screen.getByLabelText(/new project name/i)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /cancel new project/i }),
    );
    expect(screen.queryByLabelText(/new project name/i)).toBeNull();
    expect(onCreateProject).not.toHaveBeenCalled();
  });
});

describe("ManualEntryModal — task picker (#21)", () => {
  const DRAFT_WITH_PROJECT: ManualEntryDraft = {
    ...BASE_DRAFT,
    projectId: "p1",
  };

  it("hides the task picker when no loadTasks is provided", () => {
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={DRAFT_WITH_PROJECT}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText(/^task$/i)).toBeNull();
  });

  it("loads and lists tasks for the selected project", async () => {
    const loadTasks = vi.fn().mockResolvedValue(TASKS_P1);
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={DRAFT_WITH_PROJECT}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        loadTasks={loadTasks}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(loadTasks).toHaveBeenCalledWith("p1"));
    // The Task select renders the loaded options.
    expect(await screen.findByRole("option", { name: "Design" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Build" })).toBeTruthy();
  });

  it("carries the selected task id through on submit", async () => {
    const loadTasks = vi.fn().mockResolvedValue(TASKS_P1);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={DRAFT_WITH_PROJECT}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={onSubmit}
        loadTasks={loadTasks}
        onClose={vi.fn()}
      />,
    );
    await screen.findByRole("option", { name: "Design" });
    fireEvent.change(screen.getByLabelText(/^task$/i), {
      target: { value: "t2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "p1", taskId: "t2" }),
      ),
    );
  });

  it("creates a task inline and selects it", async () => {
    const loadTasks = vi.fn().mockResolvedValue(TASKS_P1);
    const created: Task = {
      id: "t3",
      projectId: "p1",
      name: "Review",
      archived: false,
    };
    const onCreateTask = vi.fn().mockResolvedValue(created);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={DRAFT_WITH_PROJECT}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={onSubmit}
        loadTasks={loadTasks}
        onCreateTask={onCreateTask}
        onClose={vi.fn()}
      />,
    );
    await screen.findByRole("option", { name: "Design" });
    fireEvent.click(screen.getByRole("button", { name: /new task/i }));
    fireEvent.change(screen.getByLabelText(/new task name/i), {
      target: { value: "Review" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add task/i }));
    await waitFor(() =>
      expect(onCreateTask).toHaveBeenCalledWith("p1", "Review"),
    );
    // The new task is now selectable and saving carries it through.
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "t3" }),
      ),
    );
  });

  it("clears the task selection when the project changes", async () => {
    const loadTasks = vi.fn().mockResolvedValue(TASKS_P1);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={{ ...DRAFT_WITH_PROJECT, taskId: "t1" }}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={onSubmit}
        loadTasks={loadTasks}
        onClose={vi.fn()}
      />,
    );
    await screen.findByRole("option", { name: "Design" });
    // Switch project — the task must reset to "No task".
    fireEvent.change(screen.getByLabelText(/^project$/i), {
      target: { value: "p2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "p2", taskId: null }),
      ),
    );
  });

  it("surfaces a backend error when task creation fails", async () => {
    const loadTasks = vi.fn().mockResolvedValue(TASKS_P1);
    const onCreateTask = vi.fn().mockRejectedValue("task write failed");
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={DRAFT_WITH_PROJECT}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        loadTasks={loadTasks}
        onCreateTask={onCreateTask}
        onClose={vi.fn()}
      />,
    );
    await screen.findByRole("option", { name: "Design" });
    fireEvent.click(screen.getByRole("button", { name: /new task/i }));
    fireEvent.change(screen.getByLabelText(/new task name/i), {
      target: { value: "Review" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add task/i }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(
        /task write failed/i,
      ),
    );
    // Sub-form stays open for a retry.
    expect(screen.getByLabelText(/new task name/i)).toBeTruthy();
  });

  it("cancel new task collapses the sub-form without creating", async () => {
    const loadTasks = vi.fn().mockResolvedValue(TASKS_P1);
    const onCreateTask = vi.fn();
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={DRAFT_WITH_PROJECT}
        projects={PROJECTS}
        runningRange={null}
        onSubmit={vi.fn()}
        loadTasks={loadTasks}
        onCreateTask={onCreateTask}
        onClose={vi.fn()}
      />,
    );
    await screen.findByRole("option", { name: "Design" });
    fireEvent.click(screen.getByRole("button", { name: /new task/i }));
    expect(screen.getByLabelText(/new task name/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /cancel new task/i }));
    expect(screen.queryByLabelText(/new task name/i)).toBeNull();
    expect(onCreateTask).not.toHaveBeenCalled();
  });
});

describe("ManualEntryModal — remote-task attribution (#110)", () => {
  const withConnector = (
    extra: Partial<Parameters<typeof ManualEntryModal>[0]> = {},
  ) => (
    <ManualEntryModal
      open
      mode="create"
      initial={{ ...BASE_DRAFT, projectId: "p1" }}
      projects={PROJECTS}
      runningRange={null}
      connectors={[GH_CONNECTOR]}
      onSubmit={vi.fn().mockResolvedValue(undefined)}
      onClose={vi.fn()}
      loadTasks={vi.fn().mockResolvedValue(TASKS_P1)}
      {...extra}
    />
  );

  it("hides the affordance when there is no enabled connector", () => {
    render(
      <ManualEntryModal
        open
        mode="create"
        initial={{ ...BASE_DRAFT, projectId: "p1" }}
        projects={PROJECTS}
        runningRange={null}
        connectors={[{ ...GH_CONNECTOR, enabled: false }]}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText(/link a connector task/i)).toBeNull();
  });

  it("links a picked task: shows the chip, an Open link, hides the local picker", async () => {
    picked.url = "https://gh/42";
    render(withConnector());
    fireEvent.click(
      screen.getByRole("button", { name: /link a connector task/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "mock-pick" }));

    const chip = await screen.findByTestId("remote-link");
    expect(chip.textContent).toContain("Fix bug");
    // The local task <select> is superseded while a remote task is linked.
    expect(screen.queryByLabelText("Task")).toBeNull();

    openUrl.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(openUrl).toHaveBeenCalledWith("https://gh/42");
  });

  it("does not offer Open for an unsafe URL scheme", async () => {
    picked.url = "javascript:alert(1)";
    render(withConnector());
    fireEvent.click(
      screen.getByRole("button", { name: /link a connector task/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "mock-pick" }));
    await screen.findByTestId("remote-link");
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
  });

  it("cancels the picker, restoring the affordance", async () => {
    render(withConnector());
    fireEvent.click(
      screen.getByRole("button", { name: /link a connector task/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "mock-cancel" }));
    expect(
      screen.getByRole("button", { name: /link a connector task/i }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "mock-pick" })).toBeNull();
  });

  it("unlinks a picked task, restoring the affordance", async () => {
    picked.url = "https://gh/42";
    render(withConnector());
    fireEvent.click(
      screen.getByRole("button", { name: /link a connector task/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "mock-pick" }));
    await screen.findByTestId("remote-link");
    fireEvent.click(screen.getByRole("button", { name: /unlink task/i }));
    expect(screen.queryByTestId("remote-link")).toBeNull();
    expect(
      screen.getByRole("button", { name: /link a connector task/i }),
    ).toBeTruthy();
  });

  it("submits the picked remote task and nulls the local task id", async () => {
    picked.url = "https://gh/42";
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      withConnector({
        initial: { ...BASE_DRAFT, projectId: "p1", taskId: "t1" },
        onSubmit,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /link a connector task/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "mock-pick" }));
    await screen.findByTestId("remote-link");
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0] as ManualEntrySubmit;
    expect(payload.taskId).toBeNull();
    expect(payload.remoteTask).toEqual({
      connectorId: "gh",
      remoteId: "42",
      label: "Fix bug",
      url: "https://gh/42",
      remoteProjectName: "Acme",
    });
  });
});
