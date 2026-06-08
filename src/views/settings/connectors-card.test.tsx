import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const listConnectors = vi.fn();
const listConnectorProjects = vi.fn();
const listConnectorTasks = vi.fn();
const setConnectorSecret = vi.fn();
const clearConnectorSecret = vi.fn();

vi.mock("../../lib/ipc", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/ipc")>("../../lib/ipc");
  return {
    ...actual,
    inTauri: true,
    listConnectors: (...a: unknown[]) => listConnectors(...a),
    listConnectorProjects: (...a: unknown[]) => listConnectorProjects(...a),
    listConnectorTasks: (...a: unknown[]) => listConnectorTasks(...a),
    setConnectorSecret: (...a: unknown[]) => setConnectorSecret(...a),
    clearConnectorSecret: (...a: unknown[]) => clearConnectorSecret(...a),
  };
});

import { ConnectorsCard } from "./connectors-card";

const fileConnector = {
  id: "sample-tasks",
  name: "Sample tasks",
  capabilities: [] as const,
  kind: { file: { format: "todotxt" as const, path: "~/TODO.txt" } },
  secret: "notRequired" as const,
};

const httpConnector = {
  id: "remote",
  name: "Remote",
  capabilities: ["network", "secrets"] as const,
  kind: { file: { format: "todotxt" as const, path: "" } },
  secret: "missing" as const,
};

beforeEach(() => {
  listConnectors.mockReset();
  listConnectorProjects.mockReset();
  listConnectorTasks.mockReset();
  setConnectorSecret.mockReset();
  clearConnectorSecret.mockReset();
});

describe("ConnectorsCard", () => {
  it("lists a connector with its kind descriptor and a Local badge", async () => {
    listConnectors.mockResolvedValue([fileConnector]);
    render(<ConnectorsCard />);

    expect(
      await screen.findByRole("button", { name: "Sample tasks" }),
    ).toBeTruthy();
    expect(screen.getByText("Local file · todotxt")).toBeTruthy();
    expect(screen.getByText("Local")).toBeTruthy();
  });

  it("shows capability badges when a connector declares them", async () => {
    listConnectors.mockResolvedValue([
      {
        id: "todoist",
        name: "Todoist",
        capabilities: ["network", "secrets"],
        kind: { file: { format: "markdown", path: "/x.md" } },
        secret: "notRequired",
      },
    ]);
    render(<ConnectorsCard />);
    expect(await screen.findByText("Network")).toBeTruthy();
    expect(screen.getByText("Secrets")).toBeTruthy();
  });

  it("describes an unknown kind generically", async () => {
    listConnectors.mockResolvedValue([
      { id: "x", name: "X", capabilities: [], kind: {}, secret: "notRequired" },
    ]);
    render(<ConnectorsCard />);
    expect(await screen.findByText("Connector")).toBeTruthy();
  });

  it("renders nothing when there are no connectors", async () => {
    listConnectors.mockResolvedValue([]);
    const { container } = render(<ConnectorsCard />);
    await waitFor(() => expect(listConnectors).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it("surfaces a load failure instead of hiding silently", async () => {
    listConnectors.mockRejectedValue(new Error("backend down"));
    render(<ConnectorsCard />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn’t load connectors");
    expect(alert.textContent).toContain("backend down");
  });

  it("expands a connector to lazily load its projects", async () => {
    listConnectors.mockResolvedValue([fileConnector]);
    listConnectorProjects.mockResolvedValue([
      { id: "cairn", name: "Cairn", description: null },
    ]);
    render(<ConnectorsCard />);

    const toggle = await screen.findByRole("button", { name: "Sample tasks" });
    expect(listConnectorProjects).not.toHaveBeenCalled();
    await userEvent.click(toggle);

    expect(await screen.findByRole("button", { name: "Cairn" })).toBeTruthy();
    expect(listConnectorProjects).toHaveBeenCalledWith("sample-tasks");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    // Collapsing hides the panel and does not refetch on re-expand.
    await userEvent.click(toggle);
    expect(screen.queryByRole("button", { name: "Cairn" })).toBeNull();
    await userEvent.click(toggle);
    await screen.findByRole("button", { name: "Cairn" });
    expect(listConnectorProjects).toHaveBeenCalledTimes(1);
  });

  it("expands a project to lazily load its tasks with done state", async () => {
    listConnectors.mockResolvedValue([fileConnector]);
    listConnectorProjects.mockResolvedValue([
      { id: "cairn", name: "Cairn", description: null },
    ]);
    listConnectorTasks.mockResolvedValue([
      { id: "t1", label: "Write spec", url: null, status: null, done: false },
      { id: "t2", label: "Ship it", url: null, status: null, done: true },
    ]);
    render(<ConnectorsCard />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Sample tasks" }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Cairn" }));

    expect(await screen.findByText("Write spec")).toBeTruthy();
    expect(listConnectorTasks).toHaveBeenCalledWith("sample-tasks", "cairn");
    const done = screen.getByText("Ship it");
    expect(done.className).toContain("connector-task--done");

    // Collapsing the project hides its tasks and does not refetch.
    await userEvent.click(screen.getByRole("button", { name: "Cairn" }));
    expect(screen.queryByText("Write spec")).toBeNull();
    expect(listConnectorTasks).toHaveBeenCalledTimes(1);
  });

  it("shows an empty-state when a connector has no projects", async () => {
    listConnectors.mockResolvedValue([fileConnector]);
    listConnectorProjects.mockResolvedValue([]);
    render(<ConnectorsCard />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Sample tasks" }),
    );
    expect(await screen.findByText("No projects.")).toBeTruthy();
  });

  it("shows an error when project loading fails", async () => {
    listConnectors.mockResolvedValue([fileConnector]);
    listConnectorProjects.mockRejectedValue(new Error("read failed"));
    render(<ConnectorsCard />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Sample tasks" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn’t load projects");
    expect(alert.textContent).toContain("read failed");
  });

  it("shows an empty-state and an error path for tasks", async () => {
    listConnectors.mockResolvedValue([fileConnector]);
    listConnectorProjects.mockResolvedValue([
      { id: "cairn", name: "Cairn", description: null },
      { id: "ops", name: "Ops", description: null },
    ]);
    listConnectorTasks.mockResolvedValueOnce([]); // Cairn → empty
    listConnectorTasks.mockRejectedValueOnce(new Error("task boom")); // Ops → error
    render(<ConnectorsCard />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Sample tasks" }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Cairn" }));
    expect(await screen.findByText("No tasks.")).toBeTruthy();

    await userEvent.click(await screen.findByRole("button", { name: "Ops" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn’t load tasks");
    expect(alert.textContent).toContain("task boom");
  });

  it("shows no token affordance for a connector that needs none", async () => {
    listConnectors.mockResolvedValue([fileConnector]);
    render(<ConnectorsCard />);
    await screen.findByRole("button", { name: "Sample tasks" });
    expect(screen.queryByText("Needs token")).toBeNull();
    expect(screen.queryByRole("button", { name: "Set token" })).toBeNull();
  });

  it("stores a typed token and reflects the refreshed state", async () => {
    listConnectors.mockResolvedValue([httpConnector]);
    setConnectorSecret.mockResolvedValue([{ ...httpConnector, secret: "set" }]);
    render(<ConnectorsCard />);

    expect(await screen.findByText("Needs token")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Set token" }));

    const input = screen.getByLabelText("API token");
    expect(input.getAttribute("type")).toBe("password");
    await userEvent.type(input, "  ghp_secret  ");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(setConnectorSecret).toHaveBeenCalledWith("remote", "ghp_secret");
    expect(await screen.findByText("Token saved")).toBeTruthy();
    expect(screen.queryByText("Needs token")).toBeNull();
  });

  it("disables Save until a non-empty token is typed", async () => {
    listConnectors.mockResolvedValue([httpConnector]);
    render(<ConnectorsCard />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Set token" }),
    );
    const save = screen.getByRole("button", { name: "Save" });
    expect(save.hasAttribute("disabled")).toBe(true);
    await userEvent.type(screen.getByLabelText("API token"), "   ");
    expect(save.hasAttribute("disabled")).toBe(true);
  });

  it("cancels the token form without calling the backend", async () => {
    listConnectors.mockResolvedValue([httpConnector]);
    render(<ConnectorsCard />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Set token" }),
    );
    await userEvent.type(screen.getByLabelText("API token"), "typed");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(setConnectorSecret).not.toHaveBeenCalled();
    // Back to the status view; re-opening shows an empty field.
    await userEvent.click(screen.getByRole("button", { name: "Set token" }));
    const reopened = screen.getByLabelText("API token") as HTMLInputElement;
    expect(reopened.value).toBe("");
  });

  it("surfaces a clear failure", async () => {
    listConnectors.mockResolvedValue([{ ...httpConnector, secret: "set" }]);
    clearConnectorSecret.mockRejectedValue(new Error("keychain locked"));
    render(<ConnectorsCard />);

    await userEvent.click(await screen.findByRole("button", { name: "Clear" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn’t update token");
    expect(alert.textContent).toContain("keychain locked");
  });

  it("clears a stored token", async () => {
    listConnectors.mockResolvedValue([{ ...httpConnector, secret: "set" }]);
    clearConnectorSecret.mockResolvedValue([
      { ...httpConnector, secret: "missing" },
    ]);
    render(<ConnectorsCard />);

    expect(await screen.findByText("Token saved")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(clearConnectorSecret).toHaveBeenCalledWith("remote");
    expect(await screen.findByText("Needs token")).toBeTruthy();
  });

  it("surfaces a token-write failure without losing the form", async () => {
    listConnectors.mockResolvedValue([httpConnector]);
    setConnectorSecret.mockRejectedValue(new Error("keychain locked"));
    render(<ConnectorsCard />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Set token" }),
    );
    await userEvent.type(screen.getByLabelText("API token"), "ghp_x");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn’t update token");
    expect(alert.textContent).toContain("keychain locked");
    expect(screen.getByLabelText("API token")).toBeTruthy();
  });

  it("ignores a connector load that resolves after unmount", async () => {
    let resolve!: (v: unknown) => void;
    listConnectors.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { unmount } = render(<ConnectorsCard />);
    unmount();
    resolve([fileConnector]);
    await waitFor(() => expect(listConnectors).toHaveBeenCalled());
  });

  it("ignores a connector load that rejects after unmount", async () => {
    let reject!: (e: unknown) => void;
    listConnectors.mockReturnValue(
      new Promise((_resolve, rej) => {
        reject = rej;
      }),
    );
    const { unmount } = render(<ConnectorsCard />);
    unmount();
    reject(new Error("late"));
    await waitFor(() => expect(listConnectors).toHaveBeenCalled());
  });
});
