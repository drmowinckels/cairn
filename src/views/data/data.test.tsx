import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));

import { DataView } from "./data";

afterEach(() => vi.clearAllMocks());

describe("DataView", () => {
  it("renders the Projects, Clients, Tasks, and Storage sections", () => {
    render(<DataView density="comfy" />);
    expect(screen.getByRole("region", { name: /^projects$/i })).toBeTruthy();
    expect(screen.getByRole("region", { name: /^clients$/i })).toBeTruthy();
    expect(screen.getByRole("region", { name: /^tasks$/i })).toBeTruthy();
    expect(
      screen.getByRole("region", { name: /local data storage/i }),
    ).toBeTruthy();
  });

  it("Export CSV in the Storage section is wired (no-op outside Tauri) (#107)", () => {
    render(<DataView density="comfy" />);
    const btn = screen.getByRole("button", { name: /export csv/i });
    expect(() => fireEvent.click(btn)).not.toThrow();
  });

  it("Export JSON in the Storage section is wired (no-op outside Tauri) (#109)", () => {
    render(<DataView density="comfy" />);
    const btn = screen.getByRole("button", { name: /export json/i });
    expect(() => fireEvent.click(btn)).not.toThrow();
  });

  it("shows the data-privacy guarantees in the Storage section", () => {
    render(<DataView density="comfy" />);
    const storage = screen.getByRole("region", {
      name: /local data storage/i,
    });
    expect(within(storage).getByText(/your data stays here/i)).toBeTruthy();
    expect(
      within(storage).getByText(/Everything is stored locally/i),
    ).toBeTruthy();
    expect(
      within(storage).getByText(
        /Window titles are read locally and never leave the device\./i,
      ),
    ).toBeTruthy();
    // The source/licence guarantee is NOT moved into Storage.
    expect(
      within(storage).queryByText(/Source on GitHub, Apache 2\.0 licensed\./i),
    ).toBeNull();
  });

  it("orders the sections Client → Project → Task (#103)", () => {
    render(<DataView density="comfy" />);
    const clients = screen.getByRole("region", { name: /^clients$/i });
    const projects = screen.getByRole("region", { name: /^projects$/i });
    const tasks = screen.getByRole("region", { name: /^tasks$/i });
    const following = Node.DOCUMENT_POSITION_FOLLOWING;
    expect(clients.compareDocumentPosition(projects) & following).toBeTruthy();
    expect(projects.compareDocumentPosition(tasks) & following).toBeTruthy();
  });

  it("adds a project through the inline add row (#103)", async () => {
    render(<DataView density="comfy" />);
    const projects = screen.getByRole("region", { name: /^projects$/i });
    fireEvent.change(within(projects).getByLabelText(/new project name/i), {
      target: { value: "Telescope" },
    });
    fireEvent.click(within(projects).getByRole("button", { name: /^add$/i }));
    await waitFor(() =>
      expect(within(projects).getByText("Telescope")).toBeTruthy(),
    );
  });

  it("edits a project's name through the Edit form", async () => {
    render(<DataView density="comfy" />);
    const projects = screen.getByRole("region", { name: /^projects$/i });
    fireEvent.click(
      within(projects).getAllByRole("button", { name: /^edit$/i })[0],
    );
    const nameInput = within(projects).getByLabelText(/^project name$/i);
    fireEvent.change(nameInput, { target: { value: "Renamed" } });
    fireEvent.click(within(projects).getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(within(projects).getByText("Renamed")).toBeTruthy(),
    );
  });

  it("initialises and edits the estimate-hours field (#106)", async () => {
    render(<DataView density="comfy" />);
    const projects = screen.getByRole("region", { name: /^projects$/i });
    // acme-web carries estimateHours: 40 in the fixture.
    const row = within(projects).getByText("acme-web").closest("li");
    fireEvent.click(
      within(row as HTMLElement).getByRole("button", { name: /^edit$/i }),
    );
    const est = within(projects).getByLabelText(
      /estimate hours/i,
    ) as HTMLInputElement;
    expect(est.value).toBe("40");
    fireEvent.change(est, { target: { value: "20" } });
    fireEvent.click(within(projects).getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(within(projects).queryByLabelText(/estimate hours/i)).toBeNull(),
    );
  });

  it("saves a project with no estimate (empty → null) (#106)", async () => {
    render(<DataView density="comfy" />);
    const projects = screen.getByRole("region", { name: /^projects$/i });
    // Cairn has estimateHours: null in the fixture → the field starts empty.
    const row = within(projects).getByText("Cairn").closest("li");
    fireEvent.click(
      within(row as HTMLElement).getByRole("button", { name: /^edit$/i }),
    );
    const est = within(projects).getByLabelText(
      /estimate hours/i,
    ) as HTMLInputElement;
    expect(est.value).toBe("");
    fireEvent.click(within(projects).getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(within(projects).queryByLabelText(/estimate hours/i)).toBeNull(),
    );
  });

  it("ignores Edit-form submit when the name is blank (#106 guard)", () => {
    render(<DataView density="comfy" />);
    const projects = screen.getByRole("region", { name: /^projects$/i });
    fireEvent.click(
      within(projects).getAllByRole("button", { name: /^edit$/i })[0],
    );
    const nameInput = within(projects).getByLabelText(/^project name$/i);
    fireEvent.change(nameInput, { target: { value: "   " } });
    fireEvent.keyDown(nameInput, { key: "Enter" });
    // The early return keeps the form open.
    expect(within(projects).getByLabelText(/^project name$/i)).toBeTruthy();
  });

  it("sets and clears a per-project rounding override through the Edit form (#107)", async () => {
    render(<DataView density="comfy" />);
    const projects = screen.getByRole("region", { name: /^projects$/i });
    fireEvent.click(
      within(projects).getAllByRole("button", { name: /^edit$/i })[0],
    );
    const override = within(projects).getByLabelText(
      /rounding override/i,
    ) as HTMLSelectElement;
    // Defaults to inheriting the global; no direction control yet.
    expect(override.value).toBe("inherit");
    expect(within(projects).queryByLabelText(/rounding direction/i)).toBeNull();

    // Pick an interval → the direction control appears, defaulting to nearest.
    fireEvent.change(override, { target: { value: "15" } });
    const direction = within(projects).getByLabelText(
      /rounding direction/i,
    ) as HTMLSelectElement;
    expect(direction.value).toBe("nearest");
    fireEvent.change(direction, { target: { value: "up" } });
    expect(direction.value).toBe("up");

    // "Off" keeps an explicit override but hides the direction control.
    fireEvent.change(override, { target: { value: "0" } });
    expect(within(projects).queryByLabelText(/rounding direction/i)).toBeNull();

    // Back to inherit clears the override.
    fireEvent.change(override, { target: { value: "inherit" } });
    expect(override.value).toBe("inherit");

    fireEvent.click(within(projects).getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(
        within(projects).queryByLabelText(/rounding override/i),
      ).toBeNull(),
    );
  });

  it("adds a project with the Enter key (and ignores other keys)", async () => {
    render(<DataView density="comfy" />);
    const projects = screen.getByRole("region", { name: /^projects$/i });
    const input = within(projects).getByLabelText(/new project name/i);
    fireEvent.change(input, { target: { value: "Comet" } });
    // A non-Enter key is a no-op; only Enter submits.
    fireEvent.keyDown(input, { key: "a" });
    expect(within(projects).queryByText("Comet")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(within(projects).getByText("Comet")).toBeTruthy(),
    );
  });

  it("ignores Enter on an empty project name", () => {
    render(<DataView density="comfy" />);
    const projects = screen.getByRole("region", { name: /^projects$/i });
    const before = within(projects).getAllByRole("button", {
      name: /^delete /i,
    }).length;
    fireEvent.keyDown(within(projects).getByLabelText(/new project name/i), {
      key: "Enter",
    });
    expect(
      within(projects).getAllByRole("button", { name: /^delete /i }).length,
    ).toBe(before);
  });

  it("reassigns a project's client through the Edit form", async () => {
    render(<DataView density="comfy" />);
    const projects = screen.getByRole("region", { name: /^projects$/i });
    // "Open source" appears once as a project's client (Cairn) before the edit.
    const before = within(projects).getAllByText("Open source").length;
    fireEvent.click(
      within(projects).getAllByRole("button", { name: /^edit$/i })[0],
    );
    fireEvent.change(within(projects).getByLabelText(/^client$/i), {
      target: { value: "c-os" },
    });
    fireEvent.click(within(projects).getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(within(projects).getAllByText("Open source").length).toBe(
        before + 1,
      ),
    );
  });

  it("clears a project's client (No client) through the Edit form", async () => {
    render(<DataView density="comfy" />);
    const projects = screen.getByRole("region", { name: /^projects$/i });
    // acme-web starts with a client; "No client" rows exist for others.
    const before = within(projects).getAllByText(/^no client$/i).length;
    fireEvent.click(
      within(projects).getAllByRole("button", { name: /^edit$/i })[0],
    );
    fireEvent.change(within(projects).getByLabelText(/^client$/i), {
      target: { value: "" },
    });
    fireEvent.click(within(projects).getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(within(projects).getAllByText(/^no client$/i).length).toBe(
        before + 1,
      ),
    );
  });

  it("switches the task project via the selector", () => {
    render(<DataView density="comfy" />);
    const tasksRegion = screen.getByRole("region", { name: /^tasks$/i });
    const select = within(tasksRegion).getByLabelText(
      /project for tasks/i,
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "cairn" } });
    expect(select.value).toBe("cairn");
    // Back to no project selected (the "" → null branch).
    fireEvent.change(select, { target: { value: "" } });
    expect(select.value).toBe("");
  });

  it("deletes a project after inline confirmation", async () => {
    render(<DataView density="comfy" />);
    const projects = screen.getByRole("region", { name: /^projects$/i });
    const deleteButtons = within(projects).getAllByRole("button", {
      name: /^delete /i,
    });
    const before = deleteButtons.length;
    // First click asks for confirmation; the row count is unchanged.
    fireEvent.click(deleteButtons[0]);
    expect(within(projects).getByText("Delete?")).toBeTruthy();
    // Confirm.
    fireEvent.click(
      within(projects).getByRole("button", { name: /^delete$/i }),
    );
    await waitFor(() =>
      expect(
        within(projects).getAllByRole("button", { name: /^delete /i }).length,
      ).toBe(before - 1),
    );
  });

  it("cancel keeps the project", async () => {
    render(<DataView density="comfy" />);
    const projects = screen.getByRole("region", { name: /^projects$/i });
    const before = within(projects).getAllByRole("button", {
      name: /^delete /i,
    }).length;
    fireEvent.click(
      within(projects).getAllByRole("button", { name: /^delete /i })[0],
    );
    fireEvent.click(
      within(projects).getByRole("button", { name: /^cancel$/i }),
    );
    expect(
      within(projects).getAllByRole("button", { name: /^delete /i }).length,
    ).toBe(before);
  });

  it("adds a client", async () => {
    render(<DataView density="comfy" />);
    const clients = screen.getByRole("region", { name: /^clients$/i });
    fireEvent.change(within(clients).getByLabelText(/new client name/i), {
      target: { value: "Studio" },
    });
    fireEvent.click(within(clients).getByRole("button", { name: /^add$/i }));
    await waitFor(() =>
      expect(within(clients).getByText("Studio")).toBeTruthy(),
    );
  });

  it("adds a task to the selected project", async () => {
    render(<DataView density="comfy" />);
    const tasksRegion = screen.getByRole("region", { name: /^tasks$/i });
    // A project is preselected (projects[0]); the add row is visible.
    const input = within(tasksRegion).getByLabelText(/new task name/i);
    fireEvent.change(input, { target: { value: "Wireframes" } });
    fireEvent.click(
      within(tasksRegion).getByRole("button", { name: /^add$/i }),
    );
    await waitFor(() =>
      expect(within(tasksRegion).getByText("Wireframes")).toBeTruthy(),
    );
  });
});

describe("DataView (inside Tauri)", () => {
  type WithInternals = { __TAURI_INTERNALS__?: unknown };
  beforeEach(() => {
    (globalThis as WithInternals).__TAURI_INTERNALS__ = {};
    vi.resetModules();
    invokeMock.mockReset();
  });
  afterEach(() => {
    delete (globalThis as WithInternals).__TAURI_INTERNALS__;
  });

  function backend(overrides: Record<string, unknown> = {}) {
    const projects = [
      {
        id: "p1",
        name: "Cairn",
        clientId: "c1",
        color: "#81b29a",
        archived: false,
      },
    ];
    const clients = [{ id: "c1", name: "ACME", color: null, archived: false }];
    let listProjectsCalls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd in overrides) {
        const v = overrides[cmd];
        return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
      }
      if (cmd === "list_projects") {
        listProjectsCalls += 1;
        return Promise.resolve(projects);
      }
      if (cmd === "list_clients") return Promise.resolve(clients);
      if (cmd === "list_tasks") return Promise.resolve([]);
      if (cmd === "data_paths")
        return Promise.resolve({
          dataDir: "/d",
          dbPath: "/d/x",
          pendingImport: null,
        });
      if (cmd === "list_data_files") return Promise.resolve([]);
      if (cmd === "get_auto_backup_settings")
        return Promise.resolve({
          enabled: false,
          dir: null,
          intervalHours: 24,
          keep: 14,
        });
      if (cmd === "auto_backup_status")
        return Promise.resolve({ lastBackupAt: null, count: 0 });
      return Promise.resolve(null);
    });
    return {
      get listProjectsCalls() {
        return listProjectsCalls;
      },
    };
  }

  it("surfaces a backend error when a delete fails", async () => {
    backend({ delete_project: new Error("db locked") });
    const { DataView: Fresh } = await import("./data");
    render(<Fresh density="comfy" />);
    const projects = screen.getByRole("region", { name: /^projects$/i });
    fireEvent.click(
      await within(projects).findByRole("button", { name: /^delete /i }),
    );
    fireEvent.click(
      within(projects).getByRole("button", { name: /^delete$/i }),
    );
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringMatching(/db locked/),
    );
  });

  it("refreshes projects after deleting a client (reflects the cascade)", async () => {
    const tracker = backend({ delete_client: null });
    const { DataView: Fresh } = await import("./data");
    render(<Fresh density="comfy" />);
    const clients = screen.getByRole("region", { name: /^clients$/i });
    await within(clients).findByText("ACME");
    const callsBefore = tracker.listProjectsCalls;
    fireEvent.click(within(clients).getByRole("button", { name: /^delete /i }));
    fireEvent.click(within(clients).getByRole("button", { name: /^delete$/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("delete_client", { id: "c1" }),
    );
    await waitFor(() =>
      expect(tracker.listProjectsCalls).toBeGreaterThan(callsBefore),
    );
  });

  it("shows estimate hours input in the Edit form", async () => {
    backend();
    const { DataView: Fresh } = await import("./data");
    render(<Fresh density="comfy" />);
    const projects = screen.getByRole("region", { name: /^projects$/i });
    fireEvent.click(
      await within(projects).findByRole("button", { name: /^edit$/i }),
    );
    expect(within(projects).getByLabelText(/estimate hours/i)).toBeTruthy();
  });

  it("saves estimate_hours when a value is entered", async () => {
    backend();
    const { DataView: Fresh } = await import("./data");
    render(<Fresh density="comfy" />);
    const projects = screen.getByRole("region", { name: /^projects$/i });
    fireEvent.click(
      await within(projects).findByRole("button", { name: /^edit$/i }),
    );
    fireEvent.change(within(projects).getByLabelText(/estimate hours/i), {
      target: { value: "40" },
    });
    fireEvent.click(within(projects).getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "save_project",
        expect.objectContaining({
          project: expect.objectContaining({ estimateHours: 40 }),
        }),
      ),
    );
  });

  it("saves null estimate when the estimate field is cleared", async () => {
    backend();
    const { DataView: Fresh } = await import("./data");
    render(<Fresh density="comfy" />);
    const projects = screen.getByRole("region", { name: /^projects$/i });
    fireEvent.click(
      await within(projects).findByRole("button", { name: /^edit$/i }),
    );
    fireEvent.change(within(projects).getByLabelText(/estimate hours/i), {
      target: { value: "" },
    });
    fireEvent.click(within(projects).getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "save_project",
        expect.objectContaining({
          project: expect.objectContaining({ estimateHours: null }),
        }),
      ),
    );
  });

  it("saves billableDefault=true when the checkbox is ticked (#109)", async () => {
    backend();
    const { DataView: Fresh } = await import("./data");
    render(<Fresh density="comfy" />);
    const projects = screen.getByRole("region", { name: /^projects$/i });
    fireEvent.click(
      await within(projects).findByRole("button", { name: /^edit$/i }),
    );
    // The fixture project carries no billableDefault → the box starts clear.
    const box = within(projects).getByRole("checkbox", {
      name: /billable by default/i,
    });
    expect(box).toHaveProperty("checked", false);
    fireEvent.click(box);
    fireEvent.click(within(projects).getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "save_project",
        expect.objectContaining({
          project: expect.objectContaining({ billableDefault: true }),
        }),
      ),
    );
  });

  it("initialises the billable checkbox from the project and saves false when unticked (#109)", async () => {
    backend({
      list_projects: [
        {
          id: "p1",
          name: "Cairn",
          clientId: null,
          color: "#81b29a",
          archived: false,
          billableDefault: true,
        },
      ],
    });
    const { DataView: Fresh } = await import("./data");
    render(<Fresh density="comfy" />);
    const region = screen.getByRole("region", { name: /^projects$/i });
    fireEvent.click(
      await within(region).findByRole("button", { name: /^edit$/i }),
    );
    const box = within(region).getByRole("checkbox", {
      name: /billable by default/i,
    });
    expect(box).toHaveProperty("checked", true);
    fireEvent.click(box);
    fireEvent.click(within(region).getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "save_project",
        expect.objectContaining({
          project: expect.objectContaining({ billableDefault: false }),
        }),
      ),
    );
  });

  it("shows the budget bar when estimate_hours is set and budget status is available", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_projects")
        return Promise.resolve([
          {
            id: "p1",
            name: "Cairn",
            clientId: "c1",
            color: "#81b29a",
            archived: false,
            estimateHours: 10,
          },
        ]);
      if (cmd === "list_clients")
        return Promise.resolve([
          { id: "c1", name: "ACME", color: null, archived: false },
        ]);
      if (cmd === "list_tasks") return Promise.resolve([]);
      if (cmd === "data_paths")
        return Promise.resolve({
          dataDir: "/d",
          dbPath: "/d/x",
          pendingImport: null,
        });
      if (cmd === "list_data_files") return Promise.resolve([]);
      if (cmd === "project_budget_status")
        return Promise.resolve({
          projectId: "p1",
          usedSeconds: 18000,
          estimateHours: 10,
        });
      if (cmd === "get_auto_backup_settings")
        return Promise.resolve({
          enabled: false,
          dir: null,
          intervalHours: 24,
          keep: 14,
        });
      if (cmd === "auto_backup_status")
        return Promise.resolve({ lastBackupAt: null, count: 0 });
      return Promise.resolve(null);
    });
    const { DataView: Fresh } = await import("./data");
    render(<Fresh density="comfy" />);
    const projects = screen.getByRole("region", { name: /^projects$/i });
    const bar = await within(projects).findByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
  });
});
