import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
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
    expect(screen.getByRole("region", { name: /local data storage/i })).toBeTruthy();
  });

  it("adds a project through the inline form", async () => {
    render(<DataView density="comfy" />);
    const projects = screen.getByRole("region", { name: /^projects$/i });
    fireEvent.click(within(projects).getByRole("button", { name: /new project/i }));
    fireEvent.change(within(projects).getByLabelText(/project name/i), {
      target: { value: "Telescope" },
    });
    fireEvent.click(within(projects).getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(within(projects).getByText("Telescope")).toBeTruthy(),
    );
  });

  it("deletes a project", async () => {
    render(<DataView density="comfy" />);
    const projects = screen.getByRole("region", { name: /^projects$/i });
    const deleteButtons = within(projects).getAllByRole("button", {
      name: /^delete /i,
    });
    const before = deleteButtons.length;
    fireEvent.click(deleteButtons[0]);
    await waitFor(() =>
      expect(
        within(projects).getAllByRole("button", { name: /^delete /i }).length,
      ).toBe(before - 1),
    );
  });

  it("adds a client", async () => {
    render(<DataView density="comfy" />);
    const clients = screen.getByRole("region", { name: /^clients$/i });
    fireEvent.change(within(clients).getByLabelText(/new client name/i), {
      target: { value: "Globex" },
    });
    fireEvent.click(within(clients).getByRole("button", { name: /^add$/i }));
    await waitFor(() => expect(within(clients).getByText("Globex")).toBeTruthy());
  });

  it("adds a task to the selected project", async () => {
    render(<DataView density="comfy" />);
    const tasksRegion = screen.getByRole("region", { name: /^tasks$/i });
    // A project is preselected (projects[0]); the add row is visible.
    const input = within(tasksRegion).getByLabelText(/new task name/i);
    fireEvent.change(input, { target: { value: "Wireframes" } });
    fireEvent.click(within(tasksRegion).getByRole("button", { name: /^add$/i }));
    await waitFor(() =>
      expect(within(tasksRegion).getByText("Wireframes")).toBeTruthy(),
    );
  });
});
