import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const listConnectors = vi.fn();
const listConnectorProjects = vi.fn();
const listConnectorTasks = vi.fn();
const setConnectorSecret = vi.fn();
const clearConnectorSecret = vi.fn();
const setConnectorEnabled = vi.fn();
const previewConnectorManifest = vi.fn();
const installConnectorManifest = vi.fn();
const openDialog = vi.fn();

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
    setConnectorEnabled: (...a: unknown[]) => setConnectorEnabled(...a),
    previewConnectorManifest: (...a: unknown[]) =>
      previewConnectorManifest(...a),
    installConnectorManifest: (...a: unknown[]) =>
      installConnectorManifest(...a),
  };
});

// The native file dialog and the popover-pin wrapper: stub `open` and run
// the pinned fn directly (avoids the real `setPinned` IPC).
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...a: unknown[]) => openDialog(...a),
}));
vi.mock("../../lib/use-backup", async () => {
  const actual = await vi.importActual<typeof import("../../lib/use-backup")>(
    "../../lib/use-backup",
  );
  return { ...actual, withPopoverPinned: (fn: () => unknown) => fn() };
});

import { ConnectorsCard } from "./connectors-card";

/** The single keychain secret of `httpConnector`, in the given state. */
const ghSecret = (state: "missing" | "set") => [
  { key: "github_token", label: "API token", state },
];

const fileConnector = {
  id: "sample-tasks",
  name: "Sample tasks",
  capabilities: [] as const,
  kind: { file: { format: "todotxt" as const, path: "~/TODO.txt" } },
  secrets: [],
  enabled: true,
};

const httpConnector = {
  id: "remote",
  name: "Remote",
  capabilities: ["network", "secrets"] as const,
  kind: { http: { baseUrl: "https://api.github.com" } },
  secrets: ghSecret("missing"),
  enabled: true,
};

/** A two-secret connector (Trello-style: a `key` set, a `token` not). */
const trelloConnector = {
  id: "trello",
  name: "Trello",
  capabilities: ["network", "secrets"] as const,
  kind: { http: { baseUrl: "https://api.trello.com" } },
  secrets: [
    { key: "trello_key", label: "key", state: "set" as const },
    { key: "trello_token", label: "token", state: "missing" as const },
  ],
  enabled: true,
};

/** Wrap items in the `CachedList` shape the connector reads now return. */
function list<T>(items: T[], stale = false) {
  return { items, stale, fetchedAt: stale ? "2026-01-01T00:00:00Z" : null };
}

beforeEach(() => {
  listConnectors.mockReset();
  listConnectorProjects.mockReset();
  listConnectorTasks.mockReset();
  setConnectorSecret.mockReset();
  clearConnectorSecret.mockReset();
  setConnectorEnabled.mockReset();
  previewConnectorManifest.mockReset();
  installConnectorManifest.mockReset();
  openDialog.mockReset();
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
        secrets: [],
        enabled: true,
      },
    ]);
    render(<ConnectorsCard />);
    expect(await screen.findByText("Network")).toBeTruthy();
    expect(screen.getByText("Secrets")).toBeTruthy();
  });

  it("describes an http connector by its remote host", async () => {
    listConnectors.mockResolvedValue([httpConnector]);
    render(<ConnectorsCard />);
    expect(await screen.findByText("Remote · api.github.com")).toBeTruthy();
  });

  it("falls back to a bare Remote label for an unparseable baseUrl", async () => {
    listConnectors.mockResolvedValue([
      {
        id: "broken",
        name: "Broken",
        capabilities: ["network"],
        kind: { http: { baseUrl: "not a url" } },
        secrets: [],
        enabled: true,
      },
    ]);
    render(<ConnectorsCard />);
    expect(await screen.findByText("Remote")).toBeTruthy();
  });

  it("describes an unknown kind generically", async () => {
    listConnectors.mockResolvedValue([
      {
        id: "x",
        name: "X",
        capabilities: [],
        kind: {},
        secrets: [],
        enabled: true,
      },
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
    listConnectorProjects.mockResolvedValue(
      list([{ id: "cairn", name: "Cairn", description: null }]),
    );
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
    listConnectorProjects.mockResolvedValue(
      list([{ id: "cairn", name: "Cairn", description: null }]),
    );
    listConnectorTasks.mockResolvedValue(
      list([
        { id: "t1", label: "Write spec", url: null, status: null, done: false },
        { id: "t2", label: "Ship it", url: null, status: null, done: true },
      ]),
    );
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
    listConnectorProjects.mockResolvedValue(list([]));
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
    listConnectorProjects.mockResolvedValue(
      list([
        { id: "cairn", name: "Cairn", description: null },
        { id: "ops", name: "Ops", description: null },
      ]),
    );
    listConnectorTasks.mockResolvedValueOnce(list([])); // Cairn → empty
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

  it("flags projects served from the offline cache as stale, with an age", async () => {
    // Compute the timestamp relative to real `now` so the rendered age is
    // deterministic without faking timers (which would stall userEvent).
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    listConnectors.mockResolvedValue([fileConnector]);
    listConnectorProjects.mockResolvedValue({
      items: [{ id: "cairn", name: "Cairn", description: null }],
      stale: true,
      fetchedAt: twoHoursAgo,
    });
    render(<ConnectorsCard />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Sample tasks" }),
    );
    expect(
      await screen.findByText(/Showing cached data from 2h ago/),
    ).toBeTruthy();
    // The cached items still render.
    expect(screen.getByRole("button", { name: "Cairn" })).toBeTruthy();
  });

  it("renders the stale note without an age when no timestamp is present", async () => {
    listConnectors.mockResolvedValue([fileConnector]);
    listConnectorProjects.mockResolvedValue({
      items: [{ id: "cairn", name: "Cairn", description: null }],
      stale: true,
      fetchedAt: null,
    });
    render(<ConnectorsCard />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Sample tasks" }),
    );
    const note = await screen.findByText(/Showing cached data/);
    // The age phrase ("…data from 2h ago") is absent; the static "refresh
    // from the connector" copy remains.
    expect(note.textContent).not.toMatch(/cached data from/);
  });

  it("re-fetches a stale list on re-expand and clears the note when live data returns", async () => {
    listConnectors.mockResolvedValue([fileConnector]);
    listConnectorProjects
      .mockResolvedValueOnce(
        list([{ id: "cairn", name: "Cairn", description: null }], true),
      )
      .mockResolvedValueOnce(
        list([{ id: "cairn", name: "Cairn", description: null }]),
      );
    render(<ConnectorsCard />);
    const toggle = await screen.findByRole("button", { name: "Sample tasks" });

    await userEvent.click(toggle); // first load → stale
    expect(await screen.findByText(/Showing cached data/)).toBeTruthy();
    await userEvent.click(toggle); // collapse
    await userEvent.click(toggle); // re-expand → re-fetch, now fresh

    await screen.findByRole("button", { name: "Cairn" });
    expect(listConnectorProjects).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Showing cached data/)).toBeNull();
  });

  it("flags tasks served from the offline cache as stale", async () => {
    listConnectors.mockResolvedValue([fileConnector]);
    listConnectorProjects.mockResolvedValue(
      list([{ id: "cairn", name: "Cairn", description: null }]),
    );
    listConnectorTasks.mockResolvedValue(
      list(
        [
          {
            id: "t1",
            label: "Write spec",
            url: null,
            status: null,
            done: false,
          },
        ],
        true,
      ),
    );
    render(<ConnectorsCard />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Sample tasks" }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Cairn" }));
    expect(await screen.findByText(/Showing cached data/)).toBeTruthy();
    expect(screen.getByText("Write spec")).toBeTruthy();
  });

  it("re-fetches stale tasks on re-expand", async () => {
    listConnectors.mockResolvedValue([fileConnector]);
    listConnectorProjects.mockResolvedValue(
      list([{ id: "cairn", name: "Cairn", description: null }]),
    );
    const task = {
      id: "t1",
      label: "Write spec",
      url: null,
      status: null,
      done: false,
    };
    listConnectorTasks
      .mockResolvedValueOnce(list([task], true)) // stale
      .mockResolvedValueOnce(list([task])); // fresh on retry
    render(<ConnectorsCard />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Sample tasks" }),
    );
    const project = await screen.findByRole("button", { name: "Cairn" });
    await userEvent.click(project); // load tasks → stale
    expect(await screen.findByText(/Showing cached data/)).toBeTruthy();
    await userEvent.click(project); // collapse
    await userEvent.click(project); // re-expand → re-fetch, fresh

    await screen.findByText("Write spec");
    expect(listConnectorTasks).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Showing cached data/)).toBeNull();
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
    setConnectorSecret.mockResolvedValue([
      { ...httpConnector, secrets: ghSecret("set") },
    ]);
    render(<ConnectorsCard />);

    expect(await screen.findByText("Needs token")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Set token" }));

    const input = screen.getByLabelText("API token");
    expect(input.getAttribute("type")).toBe("password");
    await userEvent.type(input, "  ghp_secret  ");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(setConnectorSecret).toHaveBeenCalledWith(
      "remote",
      "github_token",
      "ghp_secret",
    );
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
    listConnectors.mockResolvedValue([
      { ...httpConnector, secrets: ghSecret("set") },
    ]);
    clearConnectorSecret.mockRejectedValue(new Error("keychain locked"));
    render(<ConnectorsCard />);

    await userEvent.click(await screen.findByRole("button", { name: "Clear" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn’t update token");
    expect(alert.textContent).toContain("keychain locked");
  });

  it("clears a stored token", async () => {
    listConnectors.mockResolvedValue([
      { ...httpConnector, secrets: ghSecret("set") },
    ]);
    clearConnectorSecret.mockResolvedValue([
      { ...httpConnector, secrets: ghSecret("missing") },
    ]);
    render(<ConnectorsCard />);

    expect(await screen.findByText("Token saved")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(clearConnectorSecret).toHaveBeenCalledWith("remote", "github_token");
    expect(await screen.findByText("Needs token")).toBeTruthy();
  });

  it("renders and manages a field per secret for a multi-secret connector (#110)", async () => {
    listConnectors.mockResolvedValue([trelloConnector]);
    setConnectorSecret.mockResolvedValue([trelloConnector]);
    const { container } = render(<ConnectorsCard />);
    await screen.findByRole("button", { name: "Trello" });

    // One field per secret; the set one shows "Token saved", the other "Needs token".
    expect(container.querySelectorAll(".connector-secret").length).toBe(2);
    expect(screen.getByText("Token saved")).toBeTruthy();
    expect(screen.getByText("Needs token")).toBeTruthy();

    // The missing secret's "Set token" opens a field labeled by its name, and
    // saving routes to THAT secret's key.
    await userEvent.click(screen.getByRole("button", { name: "Set token" }));
    await userEvent.type(screen.getByLabelText("token"), "TOK");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(setConnectorSecret).toHaveBeenCalledWith(
      "trello",
      "trello_token",
      "TOK",
    );
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

  it("toggles one connector and leaves the others untouched", async () => {
    // Two connectors so the optimistic map's non-target branch is exercised.
    listConnectors.mockResolvedValue([fileConnector, httpConnector]);
    setConnectorEnabled.mockResolvedValue([
      { ...fileConnector, enabled: false },
      httpConnector,
    ]);
    render(<ConnectorsCard />);

    const sw = await screen.findByRole("switch", {
      name: "Enable Sample tasks",
    });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(sw);

    expect(setConnectorEnabled).toHaveBeenCalledWith("sample-tasks", false);
    expect(
      screen
        .getByRole("switch", { name: "Enable Sample tasks" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    // The other connector's switch is unchanged.
    expect(
      screen
        .getByRole("switch", { name: "Enable Remote" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("keeps the optimistic state when the backend returns an empty list", async () => {
    listConnectors.mockResolvedValue([fileConnector]);
    setConnectorEnabled.mockResolvedValue([]); // e.g. outside Tauri
    render(<ConnectorsCard />);

    const sw = await screen.findByRole("switch", {
      name: "Enable Sample tasks",
    });
    await userEvent.click(sw);
    // The optimistic flip stands rather than blanking the list.
    expect(
      screen
        .getByRole("switch", { name: "Enable Sample tasks" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("reverts the toggle and surfaces an error when the backend rejects", async () => {
    // Two connectors so the revert map's non-target branch is exercised too.
    listConnectors.mockResolvedValue([fileConnector, httpConnector]);
    setConnectorEnabled.mockRejectedValue(new Error("db locked"));
    render(<ConnectorsCard />);

    const sw = await screen.findByRole("switch", {
      name: "Enable Sample tasks",
    });
    await userEvent.click(sw);

    // Optimistic flip reverts back to enabled after the rejection.
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Enable Sample tasks" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    expect(
      screen
        .getByRole("switch", { name: "Enable Remote" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("db locked");
  });

  it("does not browse a disabled connector", async () => {
    listConnectors.mockResolvedValue([{ ...fileConnector, enabled: false }]);
    render(<ConnectorsCard />);

    const expand = await screen.findByRole("button", { name: "Sample tasks" });
    expect(expand.hasAttribute("disabled")).toBe(true);
    await userEvent.click(expand);
    expect(listConnectorProjects).not.toHaveBeenCalled();
  });

  const remoteManifest = {
    id: "todoist",
    name: "Todoist",
    capabilities: ["network", "secrets"],
    kind: { http: { baseUrl: "https://api.todoist.com" } },
  };

  it("previews a picked manifest and installs it on consent", async () => {
    listConnectors.mockResolvedValue([fileConnector]);
    openDialog.mockResolvedValue("/picked/todoist.json");
    previewConnectorManifest.mockResolvedValue(remoteManifest);
    installConnectorManifest.mockResolvedValue([
      fileConnector,
      { ...remoteManifest, secrets: ghSecret("missing"), enabled: true },
    ]);
    render(<ConnectorsCard />);

    await userEvent.click(
      await screen.findByRole("button", { name: /Add connector/ }),
    );
    // Consent dialog shows the name, host, and capabilities before install.
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Add Todoist?");
    expect(dialog.textContent).toContain("Remote · api.todoist.com");
    expect(previewConnectorManifest).toHaveBeenCalledWith(
      "/picked/todoist.json",
    );
    expect(installConnectorManifest).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(installConnectorManifest).toHaveBeenCalledWith(
      "/picked/todoist.json",
    );
    // The installed connector joins the list; the dialog closes.
    expect(await screen.findByRole("button", { name: "Todoist" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does nothing when the file picker is dismissed", async () => {
    listConnectors.mockResolvedValue([fileConnector]);
    openDialog.mockResolvedValue(null);
    render(<ConnectorsCard />);
    await userEvent.click(
      await screen.findByRole("button", { name: /Add connector/ }),
    );
    expect(previewConnectorManifest).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancels the consent dialog without installing", async () => {
    listConnectors.mockResolvedValue([fileConnector]);
    openDialog.mockResolvedValue("/picked/todoist.json");
    previewConnectorManifest.mockResolvedValue(remoteManifest);
    render(<ConnectorsCard />);
    await userEvent.click(
      await screen.findByRole("button", { name: /Add connector/ }),
    );
    await screen.findByRole("dialog");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(installConnectorManifest).not.toHaveBeenCalled();
  });

  it("surfaces a preview validation error", async () => {
    listConnectors.mockResolvedValue([fileConnector]);
    openDialog.mockResolvedValue("/picked/bad.json");
    previewConnectorManifest.mockRejectedValue(
      new Error("not a valid manifest"),
    );
    render(<ConnectorsCard />);
    await userEvent.click(
      await screen.findByRole("button", { name: /Add connector/ }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn’t add the connector");
    expect(alert.textContent).toContain("not a valid manifest");
  });

  it("surfaces an install failure inside the dialog", async () => {
    listConnectors.mockResolvedValue([fileConnector]);
    openDialog.mockResolvedValue("/picked/todoist.json");
    previewConnectorManifest.mockResolvedValue(remoteManifest);
    installConnectorManifest.mockRejectedValue(new Error("disk full"));
    render(<ConnectorsCard />);
    await userEvent.click(
      await screen.findByRole("button", { name: /Add connector/ }),
    );
    await screen.findByRole("dialog");
    await userEvent.click(screen.getByRole("button", { name: "Install" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("disk full");
    // Dialog stays open so the user can retry or cancel.
    expect(screen.queryByRole("dialog")).not.toBeNull();
  });

  it("closes the consent dialog on Escape and on a backdrop click", async () => {
    listConnectors.mockResolvedValue([fileConnector]);
    openDialog.mockResolvedValue("/picked/todoist.json");
    previewConnectorManifest.mockResolvedValue(remoteManifest);
    render(<ConnectorsCard />);

    const addBtn = await screen.findByRole("button", { name: /Add connector/ });
    await userEvent.click(addBtn);
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    // Re-open, then click the backdrop (the overlay outside the dialog).
    await userEvent.click(addBtn);
    const overlay = (await screen.findByRole("dialog")).parentElement!;
    fireEvent.mouseDown(overlay);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(installConnectorManifest).not.toHaveBeenCalled();
  });

  it("marks a local (no-capability) manifest as local in the consent dialog", async () => {
    listConnectors.mockResolvedValue([fileConnector]);
    openDialog.mockResolvedValue("/picked/local.json");
    previewConnectorManifest.mockResolvedValue({
      id: "my-todo",
      name: "My TODO",
      capabilities: [],
      kind: { file: { format: "todotxt", path: "~/T.txt" } },
    });
    render(<ConnectorsCard />);
    await userEvent.click(
      await screen.findByRole("button", { name: /Add connector/ }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Local — no network or secrets");
  });

  it("shows no dialog when the preview yields nothing", async () => {
    listConnectors.mockResolvedValue([fileConnector]);
    openDialog.mockResolvedValue("/picked/x.json");
    previewConnectorManifest.mockResolvedValue(null);
    render(<ConnectorsCard />);
    await userEvent.click(
      await screen.findByRole("button", { name: /Add connector/ }),
    );
    await waitFor(() => expect(previewConnectorManifest).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
