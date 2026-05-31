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
      if (cmd in overrides) {
        const v = overrides[cmd];
        return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
      }
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
});
