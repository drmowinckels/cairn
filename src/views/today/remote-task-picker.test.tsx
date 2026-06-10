import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const listConnectorProjects = vi.fn();
const listConnectorTasks = vi.fn();
vi.mock("../../lib/ipc", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/ipc")>("../../lib/ipc");
  return {
    ...actual,
    listConnectorProjects: (...a: unknown[]) => listConnectorProjects(...a),
    listConnectorTasks: (...a: unknown[]) => listConnectorTasks(...a),
  };
});

import { RemoteTaskPicker } from "./remote-task-picker";
import type { Connector } from "../../lib/ipc";

const CONNECTORS: Connector[] = [
  {
    id: "gh",
    name: "GitHub Projects",
    capabilities: ["network", "secrets"],
    kind: { http: { baseUrl: "https://api.github.com" } },
    secrets: [],
    enabled: true,
  },
];

const TWO_CONNECTORS: Connector[] = [
  CONNECTORS[0],
  {
    id: "gl",
    name: "GitLab",
    capabilities: ["network", "secrets"],
    kind: { http: { baseUrl: "https://gitlab.com" } },
    secrets: [],
    enabled: true,
  },
];

function list<T>(items: T[], stale = false) {
  return { items, stale, fetchedAt: stale ? "2026-01-01T00:00:00Z" : null };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("RemoteTaskPicker", () => {
  it("drills connector → project → task and reports the pick", async () => {
    listConnectorProjects.mockResolvedValue(
      list([{ id: "acme", name: "Acme", description: null }]),
    );
    listConnectorTasks.mockResolvedValue(
      list([
        {
          id: "42",
          label: "Fix bug",
          url: "https://gh/42",
          status: null,
          done: false,
        },
      ]),
    );
    const onPick = vi.fn();
    render(
      <RemoteTaskPicker
        connectors={CONNECTORS}
        onPick={onPick}
        onCancel={vi.fn()}
      />,
    );

    await userEvent.selectOptions(screen.getByLabelText("Connector"), "gh");
    expect(listConnectorProjects).toHaveBeenCalledWith("gh");

    const projectSelect = await screen.findByLabelText("Project");
    await userEvent.selectOptions(projectSelect, "acme");
    expect(listConnectorTasks).toHaveBeenCalledWith("gh", "acme");

    const taskSelect = await screen.findByLabelText("Task");
    await userEvent.selectOptions(taskSelect, "42");

    expect(onPick).toHaveBeenCalledWith({
      connectorId: "gh",
      remoteId: "42",
      label: "Fix bug",
      url: "https://gh/42",
      remoteProjectName: "Acme",
    });
  });

  it("flags a stale (offline) project list", async () => {
    listConnectorProjects.mockResolvedValue(
      list([{ id: "acme", name: "Acme", description: null }], true),
    );
    render(
      <RemoteTaskPicker
        connectors={CONNECTORS}
        onPick={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.selectOptions(screen.getByLabelText("Connector"), "gh");
    await waitFor(() => expect(screen.getByText(/offline copy/i)).toBeTruthy());
  });

  it("surfaces a load error (Error instance)", async () => {
    listConnectorProjects.mockRejectedValue(new Error("boom"));
    render(
      <RemoteTaskPicker
        connectors={CONNECTORS}
        onPick={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.selectOptions(screen.getByLabelText("Connector"), "gh");
    expect((await screen.findByRole("alert")).textContent).toContain("boom");
  });

  it("surfaces a non-Error rejection by stringifying it", async () => {
    listConnectorProjects.mockRejectedValue("offline");
    render(
      <RemoteTaskPicker
        connectors={CONNECTORS}
        onPick={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.selectOptions(screen.getByLabelText("Connector"), "gh");
    expect((await screen.findByRole("alert")).textContent).toContain("offline");
  });

  it("ignores selecting the task placeholder (no pick)", async () => {
    listConnectorProjects.mockResolvedValue(
      list([{ id: "acme", name: "Acme", description: null }]),
    );
    listConnectorTasks.mockResolvedValue(
      list([
        {
          id: "42",
          label: "Done item",
          url: null,
          status: null,
          done: true,
        },
        {
          id: "43",
          label: "Open item",
          url: null,
          status: null,
          done: false,
        },
      ]),
    );
    const onPick = vi.fn();
    render(
      <RemoteTaskPicker
        connectors={CONNECTORS}
        onPick={onPick}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.selectOptions(screen.getByLabelText("Connector"), "gh");
    await userEvent.selectOptions(
      await screen.findByLabelText("Project"),
      "acme",
    );
    const taskSelect = await screen.findByLabelText("Task");
    // A done task shows a ✓ prefix, an open one does not (both option arms).
    expect(taskSelect.textContent).toContain("✓ Done item");
    expect(taskSelect.textContent).toContain("Open item");
    // Re-selecting the placeholder must not fire a pick.
    await userEvent.selectOptions(taskSelect, "");
    expect(onPick).not.toHaveBeenCalled();
  });

  it("flags a stale (offline) task list", async () => {
    listConnectorProjects.mockResolvedValue(
      list([{ id: "acme", name: "Acme", description: null }]),
    );
    listConnectorTasks.mockResolvedValue(
      list(
        [{ id: "42", label: "X", url: null, status: null, done: false }],
        true,
      ),
    );
    render(
      <RemoteTaskPicker
        connectors={CONNECTORS}
        onPick={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.selectOptions(screen.getByLabelText("Connector"), "gh");
    await userEvent.selectOptions(
      await screen.findByLabelText("Project"),
      "acme",
    );
    // The Task label now carries the stale note in its accessible name.
    await screen.findByLabelText(/Task/);
    expect(screen.getAllByText(/offline copy/i).length).toBeGreaterThan(0);
  });

  it("ignores a fetch that resolves after the connector changed", async () => {
    let resolveFirst!: (v: ReturnType<typeof list>) => void;
    listConnectorProjects
      .mockReturnValueOnce(
        new Promise((r) => {
          resolveFirst = r;
        }),
      )
      .mockResolvedValue(list([{ id: "b", name: "Beta", description: null }]));
    render(
      <RemoteTaskPicker
        connectors={TWO_CONNECTORS}
        onPick={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // Select the first connector (its projects fetch hangs), then switch —
    // the first effect's cleanup marks it cancelled.
    await userEvent.selectOptions(screen.getByLabelText("Connector"), "gh");
    await userEvent.selectOptions(screen.getByLabelText("Connector"), "gl");
    // The second connector's projects load.
    expect(await screen.findByRole("option", { name: "Beta" })).toBeTruthy();
    // Now resolve the first, stale fetch — it must be ignored (no "Acme").
    resolveFirst(list([{ id: "acme", name: "Acme", description: null }]));
    await Promise.resolve();
    expect(screen.queryByRole("option", { name: "Acme" })).toBeNull();
  });

  it("shows an empty hint and a cancel when no connectors are enabled", async () => {
    const onCancel = vi.fn();
    render(
      <RemoteTaskPicker connectors={[]} onPick={vi.fn()} onCancel={onCancel} />,
    );
    expect(screen.getByText(/no connectors enabled/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(listConnectorProjects).not.toHaveBeenCalled();
  });
});
