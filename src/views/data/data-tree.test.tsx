import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
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

import { buildGroups, DataTree } from "./data-tree";
import type { ClientGroup } from "./data-tree";
import type { Client, Project } from "../../lib/types";
import type { UseProjects } from "../../lib/use-projects";
import type { UseClients } from "../../lib/use-clients";
import { CLIENTS, PROJECTS } from "../../test-fixtures/data";

afterEach(() => vi.clearAllMocks());

// ── buildGroups unit tests ────────────────────────────────────────────────

describe("buildGroups", () => {
  it("groups projects under their client", () => {
    const groups = buildGroups(PROJECTS, CLIENTS);
    const acmeGroup = groups.find((g) => g.clientId === "c-acme");
    expect(acmeGroup).toBeDefined();
    expect(acmeGroup!.projects.map((p) => p.id)).toContain("acme");
  });

  it("creates a null-client group for clientless projects", () => {
    const groups = buildGroups(PROJECTS, CLIENTS);
    const noClient = groups.find((g) => g.clientId === null);
    expect(noClient).toBeDefined();
    const ids = noClient!.projects.map((p) => p.id);
    expect(ids).toContain("site");
    expect(ids).toContain("mtg");
  });

  it("returns an empty array when there are no projects", () => {
    expect(buildGroups([], CLIENTS)).toEqual([]);
  });

  it("handles projects whose clientId references a non-existent client", () => {
    const orphan: Project = {
      id: "orphan",
      name: "Orphan",
      clientId: "c-ghost",
      color: "#fff",
      archived: false,
      estimateHours: null,
    };
    const groups = buildGroups([orphan], CLIENTS);
    expect(groups.length).toBe(1);
    expect(groups[0].client).toBeNull();
  });

  it("preserves insertion order for client groups", () => {
    const groups = buildGroups(PROJECTS, CLIENTS);
    const clientIds = groups.map((g) => g.clientId);
    // PROJECTS order: acme(c-acme), cairn(c-os), site(null), ops(c-internal), mtg(null)
    // null already seen after site, so mtg doesn't create a second null group
    expect(clientIds[0]).toBe("c-acme");
    expect(clientIds[1]).toBe("c-os");
    expect(clientIds[2]).toBeNull();
    expect(clientIds[3]).toBe("c-internal");
    expect(clientIds).not.toContain(undefined);
  });

  it("sets client to null for the clientless group even when clients are present", () => {
    const groups = buildGroups(PROJECTS, CLIENTS);
    const noClientGroup = groups.find(
      (g) => g.clientId === null,
    ) as ClientGroup;
    expect(noClientGroup.client).toBeNull();
  });
});

// ── DataTree component tests ──────────────────────────────────────────────

function makeProjects(overrides: Partial<UseProjects> = {}): UseProjects {
  let projects = [...PROJECTS];
  return {
    get projects() {
      return projects;
    },
    refresh: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockImplementation(async (input) => {
      const p: Project = {
        id: `local-${input.name}`,
        name: input.name,
        color: input.color,
        clientId: input.clientId ?? null,
        archived: false,
        estimateHours: null,
      };
      projects = [...projects, p];
      return p;
    }),
    update: vi.fn().mockResolvedValue(PROJECTS[0]),
    remove: vi.fn().mockImplementation(async (id: string) => {
      projects = projects.filter((p) => p.id !== id);
    }),
    ...overrides,
  };
}

function makeClients(overrides: Partial<UseClients> = {}): UseClients {
  return {
    clients: [...CLIENTS],
    refresh: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(CLIENTS[0]),
    update: vi.fn().mockResolvedValue(CLIENTS[0]),
    remove: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const noopRun = vi
  .fn()
  .mockImplementation(async (fn: () => Promise<unknown>) => {
    await fn();
  });

describe("DataTree", () => {
  it("renders client group labels", () => {
    render(
      <DataTree
        projects={makeProjects()}
        clients={makeClients()}
        run={noopRun}
      />,
    );
    expect(screen.getByText("ACME Co.")).toBeTruthy();
    expect(screen.getByText("Open source")).toBeTruthy();
    expect(screen.getByText("Internal")).toBeTruthy();
  });

  it("renders a 'No client' group for clientless projects", () => {
    render(
      <DataTree
        projects={makeProjects()}
        clients={makeClients()}
        run={noopRun}
      />,
    );
    expect(screen.getByText("No client")).toBeTruthy();
  });

  it("shows project names inside their client group", () => {
    render(
      <DataTree
        projects={makeProjects()}
        clients={makeClients()}
        run={noopRun}
      />,
    );
    expect(screen.getByText("acme-web")).toBeTruthy();
    expect(screen.getByText("Cairn")).toBeTruthy();
  });

  it("shows an empty state when there are no projects", () => {
    const empty = makeProjects({
      projects: [],
    } as unknown as Partial<UseProjects>);
    render(<DataTree projects={empty} clients={makeClients()} run={noopRun} />);
    expect(screen.getByText(/no projects yet/i)).toBeTruthy();
  });

  it("uses role=tree on the root list", () => {
    render(
      <DataTree
        projects={makeProjects()}
        clients={makeClients()}
        run={noopRun}
      />,
    );
    expect(screen.getByRole("tree")).toBeTruthy();
  });

  it("expands a project node to show tasks on click", async () => {
    render(
      <DataTree
        projects={makeProjects()}
        clients={makeClients()}
        run={noopRun}
      />,
    );
    const expandBtn = screen.getAllByRole("button", {
      name: /expand acme-web/i,
    })[0];
    fireEvent.click(expandBtn);
    await waitFor(() =>
      expect(screen.getByLabelText(/new task for acme-web/i)).toBeTruthy(),
    );
  });

  it("shows tasks from the fixture under the expanded project", async () => {
    render(
      <DataTree
        projects={makeProjects()}
        clients={makeClients()}
        run={noopRun}
      />,
    );
    const expandBtn = screen.getAllByRole("button", {
      name: /expand acme-web/i,
    })[0];
    fireEvent.click(expandBtn);
    await waitFor(() => expect(screen.getByText("Design")).toBeTruthy());
    expect(screen.getByText("Implementation")).toBeTruthy();
  });

  it("collapses an expanded project on second click", async () => {
    render(
      <DataTree
        projects={makeProjects()}
        clients={makeClients()}
        run={noopRun}
      />,
    );
    const expandBtn = screen.getAllByRole("button", {
      name: /expand acme-web/i,
    })[0];
    fireEvent.click(expandBtn);
    await waitFor(() =>
      expect(screen.getByLabelText(/new task for acme-web/i)).toBeTruthy(),
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: /collapse acme-web/i })[0],
    );
    await waitFor(() =>
      expect(screen.queryByLabelText(/new task for acme-web/i)).toBeNull(),
    );
  });

  it("adds a task to a project inside the tree", async () => {
    render(
      <DataTree
        projects={makeProjects()}
        clients={makeClients()}
        run={noopRun}
      />,
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: /expand acme-web/i })[0],
    );
    const input = await screen.findByLabelText(/new task for acme-web/i);
    fireEvent.change(input, { target: { value: "New task" } });
    fireEvent.click(screen.getAllByRole("button", { name: /^add$/i })[0]);
    await waitFor(() => expect(screen.getByText("New task")).toBeTruthy());
  });

  it("adds a task via Enter key", async () => {
    render(
      <DataTree
        projects={makeProjects()}
        clients={makeClients()}
        run={noopRun}
      />,
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: /expand acme-web/i })[0],
    );
    const input = await screen.findByLabelText(/new task for acme-web/i);
    fireEvent.change(input, { target: { value: "Keyboard task" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByText("Keyboard task")).toBeTruthy());
  });

  it("ignores non-Enter keys in the task input", async () => {
    render(
      <DataTree
        projects={makeProjects()}
        clients={makeClients()}
        run={noopRun}
      />,
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: /expand acme-web/i })[0],
    );
    const input = await screen.findByLabelText(/new task for acme-web/i);
    fireEvent.change(input, { target: { value: "No add" } });
    fireEvent.keyDown(input, { key: "a" });
    expect(screen.queryByText("No add")).toBeNull();
  });

  it("does not add a task on empty input", async () => {
    render(
      <DataTree
        projects={makeProjects()}
        clients={makeClients()}
        run={noopRun}
      />,
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: /expand acme-web/i })[0],
    );
    const addBtn = await screen.findAllByRole("button", { name: /^add$/i });
    expect(addBtn[0]).toHaveProperty("disabled", true);
  });

  it("adds a project under a client group", async () => {
    const p = makeProjects();
    render(<DataTree projects={p} clients={makeClients()} run={noopRun} />);
    const acmeInput = screen.getByLabelText(/new project under acme co/i);
    fireEvent.change(acmeInput, { target: { value: "New ACME Project" } });
    fireEvent.click(
      within(acmeInput.closest(".tree-client")!).getByRole("button", {
        name: /^add$/i,
      }),
    );
    await waitFor(() =>
      expect(p.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "New ACME Project",
          clientId: "c-acme",
        }),
      ),
    );
  });

  it("adds a project via Enter key in group input", async () => {
    const p = makeProjects();
    render(<DataTree projects={p} clients={makeClients()} run={noopRun} />);
    const acmeInput = screen.getByLabelText(/new project under acme co/i);
    fireEvent.change(acmeInput, { target: { value: "Enter project" } });
    fireEvent.keyDown(acmeInput, { key: "Enter" });
    await waitFor(() =>
      expect(p.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Enter project" }),
      ),
    );
  });

  it("ignores non-Enter keys in project group input", async () => {
    const p = makeProjects();
    render(<DataTree projects={p} clients={makeClients()} run={noopRun} />);
    const acmeInput = screen.getByLabelText(/new project under acme co/i);
    fireEvent.change(acmeInput, { target: { value: "Not added" } });
    fireEvent.keyDown(acmeInput, { key: "a" });
    expect(p.create).not.toHaveBeenCalled();
  });

  it("project add button is disabled when input is empty", () => {
    render(
      <DataTree
        projects={makeProjects()}
        clients={makeClients()}
        run={noopRun}
      />,
    );
    const acmeInput = screen.getByLabelText(/new project under acme co/i);
    const addBtn = within(acmeInput.closest(".tree-client")!).getByRole(
      "button",
      { name: /^add$/i },
    );
    expect(addBtn).toHaveProperty("disabled", true);
  });

  it("adds a project under the 'No client' group with null clientId", async () => {
    const p = makeProjects();
    render(<DataTree projects={p} clients={makeClients()} run={noopRun} />);
    const noClientInput = screen.getByLabelText(/new project under no client/i);
    fireEvent.change(noClientInput, { target: { value: "Free agent" } });
    fireEvent.click(
      within(noClientInput.closest(".tree-client")!).getByRole("button", {
        name: /^add$/i,
      }),
    );
    await waitFor(() =>
      expect(p.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Free agent", clientId: null }),
      ),
    );
  });

  it("shows project count in the client group header", () => {
    render(
      <DataTree
        projects={makeProjects()}
        clients={makeClients()}
        run={noopRun}
      />,
    );
    const acmeLabel = screen
      .getByText("ACME Co.")
      .closest(".tree-client-label")!;
    expect(
      within(acmeLabel as HTMLElement).getByText(/1 project/),
    ).toBeTruthy();
  });

  it("shows 'projects' (plural) when count > 1", () => {
    render(
      <DataTree
        projects={makeProjects()}
        clients={makeClients()}
        run={noopRun}
      />,
    );
    const osLabel = screen
      .getByText("No client")
      .closest(".tree-client-label")!;
    expect(within(osLabel as HTMLElement).getByText(/2 projects/)).toBeTruthy();
  });

  it("deletes a project after inline confirmation — calls remove", async () => {
    const p = makeProjects();
    render(<DataTree projects={p} clients={makeClients()} run={noopRun} />);
    const deleteBtn = screen.getByRole("button", { name: /delete acme-web/i });
    fireEvent.click(deleteBtn);
    expect(screen.getByText("Delete?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(p.remove).toHaveBeenCalledWith("acme"));
  });

  it("cancel on project delete keeps the delete button (no remove called)", () => {
    const p = makeProjects();
    render(<DataTree projects={p} clients={makeClients()} run={noopRun} />);
    fireEvent.click(screen.getByRole("button", { name: /delete acme-web/i }));
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(
      screen.getByRole("button", { name: /delete acme-web/i }),
    ).toBeTruthy();
    expect(p.remove).not.toHaveBeenCalled();
  });

  it("deletes a task after inline confirmation", async () => {
    render(
      <DataTree
        projects={makeProjects()}
        clients={makeClients()}
        run={noopRun}
      />,
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: /expand acme-web/i })[0],
    );
    const deleteDesignBtn = await screen.findByRole("button", {
      name: /delete design/i,
    });
    fireEvent.click(deleteDesignBtn);
    expect(screen.getByText("Delete?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /delete design/i }),
      ).toBeNull(),
    );
  });

  it("cancel on task delete keeps it visible", async () => {
    render(
      <DataTree
        projects={makeProjects()}
        clients={makeClients()}
        run={noopRun}
      />,
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: /expand acme-web/i })[0],
    );
    const deleteDesignBtn = await screen.findByRole("button", {
      name: /delete design/i,
    });
    fireEvent.click(deleteDesignBtn);
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(screen.getByRole("button", { name: /delete design/i })).toBeTruthy();
  });

  it("projects with no tasks show an empty state", async () => {
    const projectsWithNoTasks: Project[] = [
      {
        id: "empty-proj",
        name: "Empty",
        clientId: null,
        color: "#fff",
        archived: false,
        estimateHours: null,
      },
    ];
    const p = makeProjects({
      projects: projectsWithNoTasks,
    } as unknown as Partial<UseProjects>);
    render(<DataTree projects={p} clients={makeClients()} run={noopRun} />);
    fireEvent.click(screen.getByRole("button", { name: /expand empty/i }));
    await waitFor(() => expect(screen.getByText(/no tasks/i)).toBeTruthy());
  });

  it("shows an empty projects message inside a client group with no projects", () => {
    const clientsOnly: Client[] = [
      { id: "c-empty", name: "Ghost client", color: null, archived: false },
    ];
    const projectsUnderOtherClient: Project[] = [
      {
        id: "p1",
        name: "Alpha",
        clientId: "c-other",
        color: "#abc",
        archived: false,
        estimateHours: null,
      },
    ];
    const p = makeProjects({
      projects: projectsUnderOtherClient,
    } as unknown as Partial<UseProjects>);
    const c = makeClients({
      clients: clientsOnly,
    } as unknown as Partial<UseClients>);
    render(<DataTree projects={p} clients={c} run={noopRun} />);
    // The group for c-other is rendered (no named client), projects visible
    expect(screen.getByText("Alpha")).toBeTruthy();
  });

  it("shows top-level empty state when there are no projects at all", () => {
    const p = makeProjects({ projects: [] } as unknown as Partial<UseProjects>);
    render(<DataTree projects={p} clients={makeClients()} run={noopRun} />);
    expect(screen.getByText(/no projects yet/i)).toBeTruthy();
  });

  it("does not add task on empty draft (guards the early-return branch)", async () => {
    const p = makeProjects();
    render(<DataTree projects={p} clients={makeClients()} run={noopRun} />);
    fireEvent.click(
      screen.getAllByRole("button", { name: /expand acme-web/i })[0],
    );
    const input = await screen.findByLabelText(/new task for acme-web/i);
    // Draft is empty; Add button is disabled but we fire keyDown to exercise the guard
    fireEvent.keyDown(input, { key: "Enter" });
    expect(noopRun).not.toHaveBeenCalled();
  });

  it("does not add project on empty draft (guards addProject early-return)", () => {
    const p = makeProjects();
    render(<DataTree projects={p} clients={makeClients()} run={noopRun} />);
    const acmeInput = screen.getByLabelText(/new project under acme co/i);
    // Input is empty; fire Enter to exercise the early-return guard
    fireEvent.keyDown(acmeInput, { key: "Enter" });
    expect(p.create).not.toHaveBeenCalled();
  });

  // ── WAI-ARIA tree keyboard navigation (#147) ──────────────────────────

  function renderTree() {
    return render(
      <DataTree
        projects={makeProjects()}
        clients={makeClients()}
        run={noopRun}
      />,
    );
  }
  const treeitems = (c: HTMLElement) =>
    Array.from(c.querySelectorAll<HTMLElement>('[role="treeitem"]'));
  const tabbable = (c: HTMLElement) =>
    treeitems(c).filter((el) => el.getAttribute("tabindex") === "0");

  it("exposes exactly one tabbable treeitem (roving tabindex)", () => {
    const { container } = renderTree();
    const roving = tabbable(container);
    expect(roving).toHaveLength(1);
    // The first treeitem (first client group) is the initial tab stop.
    expect(roving[0].getAttribute("aria-label")).toBe("ACME Co.");
  });

  it("ArrowDown moves the roving focus to the next treeitem", () => {
    const { container } = renderTree();
    const first = tabbable(container)[0];
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    const roving = tabbable(container);
    expect(roving).toHaveLength(1);
    expect(roving[0].getAttribute("aria-label")).toBe("acme-web");
    expect(document.activeElement).toBe(roving[0]);
  });

  it("ArrowRight expands a collapsed project; ArrowLeft collapses it", async () => {
    const { container } = renderTree();
    const acme = treeitems(container).find(
      (el) => el.getAttribute("aria-label") === "acme-web",
    )!;
    acme.focus();
    expect(acme.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(acme, { key: "ArrowRight" });
    await waitFor(() =>
      expect(acme.getAttribute("aria-expanded")).toBe("true"),
    );
    expect(screen.getByLabelText(/new task for acme-web/i)).toBeTruthy();
    fireEvent.keyDown(acme, { key: "ArrowLeft" });
    await waitFor(() =>
      expect(acme.getAttribute("aria-expanded")).toBe("false"),
    );
  });

  it("ArrowLeft on a collapsed project moves focus to its parent client", () => {
    const { container } = renderTree();
    const acmeProj = treeitems(container).find(
      (el) => el.getAttribute("aria-label") === "acme-web",
    )!;
    acmeProj.focus();
    fireEvent.keyDown(acmeProj, { key: "ArrowLeft" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("ACME Co.");
  });

  it("Enter toggles project expansion", async () => {
    const { container } = renderTree();
    const acme = treeitems(container).find(
      (el) => el.getAttribute("aria-label") === "acme-web",
    )!;
    acme.focus();
    fireEvent.keyDown(acme, { key: "Enter" });
    await waitFor(() =>
      expect(acme.getAttribute("aria-expanded")).toBe("true"),
    );
  });

  it("End jumps to the last treeitem, Home back to the first", () => {
    const { container } = renderTree();
    const first = tabbable(container)[0];
    first.focus();
    fireEvent.keyDown(first, { key: "End" });
    const items = treeitems(container);
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
  });

  it("does not hijack arrow keys typed in the add-project input", () => {
    const { container } = renderTree();
    const input = screen.getByLabelText(/new project under acme co/i);
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    // Focus stays in the input; the roving tab stop is unchanged.
    expect(document.activeElement).toBe(input);
    expect(tabbable(container)[0].getAttribute("aria-label")).toBe("ACME Co.");
  });

  it("ignores non-navigation keys pressed on a treeitem", () => {
    const { container } = renderTree();
    const first = tabbable(container)[0];
    first.focus();
    fireEvent.keyDown(first, { key: "a" });
    // No movement, no expansion, focus unchanged.
    expect(document.activeElement).toBe(first);
    expect(tabbable(container)[0].getAttribute("aria-label")).toBe("ACME Co.");
  });

  it("keeps the roving focus valid when the active project is removed", () => {
    const projects = makeProjects();
    const { container, rerender } = render(
      <DataTree projects={projects} clients={makeClients()} run={noopRun} />,
    );
    // Navigate onto the acme-web project so activeId points at it.
    const first = tabbable(container)[0];
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(tabbable(container)[0].getAttribute("aria-label")).toBe("acme-web");

    // Re-render with acme-web gone; the effect must re-seat the roving
    // tab stop onto a node that still exists.
    const fewer = makeProjects({
      projects: PROJECTS.filter((p) => p.id !== "acme"),
    } as unknown as Partial<UseProjects>);
    rerender(
      <DataTree projects={fewer} clients={makeClients()} run={noopRun} />,
    );
    const roving = tabbable(container);
    expect(roving).toHaveLength(1);
    expect(roving[0].getAttribute("aria-label")).not.toBe("acme-web");
  });

  it("does not add duplicate local task (already-exists branch)", async () => {
    const p = makeProjects();
    render(<DataTree projects={p} clients={makeClients()} run={noopRun} />);
    fireEvent.click(
      screen.getAllByRole("button", { name: /expand acme-web/i })[0],
    );
    const input = await screen.findByLabelText(/new task for acme-web/i);
    // Add the task twice — second add should not duplicate it
    fireEvent.change(input, { target: { value: "Unique task" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByText("Unique task")).toBeTruthy());
    fireEvent.change(input, { target: { value: "unique-task" } });
    fireEvent.change(input, { target: { value: "Unique task" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // Still only one instance
    expect(screen.getAllByText("Unique task").length).toBe(1);
  });
});

// ── DataView integration: toggle tests ───────────────────────────────────

import { DataView } from "./data";

describe("DataView — view mode toggle", () => {
  afterEach(() => window.localStorage.clear());

  it("defaults to sections mode (flat sections visible)", () => {
    render(<DataView density="comfy" />);
    expect(screen.getByRole("region", { name: /^clients$/i })).toBeTruthy();
    expect(screen.getByRole("region", { name: /^projects$/i })).toBeTruthy();
    expect(screen.getByRole("region", { name: /^tasks$/i })).toBeTruthy();
    expect(screen.queryByRole("tree")).toBeNull();
  });

  it("switches to tree mode when Tree button is pressed", () => {
    render(<DataView density="comfy" />);
    fireEvent.click(screen.getByRole("button", { name: /^tree$/i }));
    expect(screen.getByRole("tree")).toBeTruthy();
    expect(screen.queryByRole("region", { name: /^clients$/i })).toBeNull();
  });

  it("switches back to sections mode when Sections button is pressed", () => {
    render(<DataView density="comfy" />);
    fireEvent.click(screen.getByRole("button", { name: /^tree$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^sections$/i }));
    expect(screen.queryByRole("tree")).toBeNull();
    expect(screen.getByRole("region", { name: /^clients$/i })).toBeTruthy();
  });

  it("persists tree mode to localStorage", () => {
    render(<DataView density="comfy" />);
    fireEvent.click(screen.getByRole("button", { name: /^tree$/i }));
    expect(window.localStorage.getItem("cairn:data-view:v1")).toBe("tree");
  });

  it("reads persisted tree mode from localStorage on mount", () => {
    window.localStorage.setItem("cairn:data-view:v1", "tree");
    render(<DataView density="comfy" />);
    expect(screen.getByRole("tree")).toBeTruthy();
  });

  it("toggle buttons have aria-pressed reflecting current mode", () => {
    render(<DataView density="comfy" />);
    const sectionsBtn = screen.getByRole("button", { name: /^sections$/i });
    const treeBtn = screen.getByRole("button", { name: /^tree$/i });
    expect(sectionsBtn.getAttribute("aria-pressed")).toBe("true");
    expect(treeBtn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(treeBtn);
    expect(sectionsBtn.getAttribute("aria-pressed")).toBe("false");
    expect(treeBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("Storage section is always visible in both modes", () => {
    render(<DataView density="comfy" />);
    expect(
      screen.getByRole("region", { name: /local data storage/i }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^tree$/i }));
    expect(
      screen.getByRole("region", { name: /local data storage/i }),
    ).toBeTruthy();
  });
});

// ── Tauri-path coverage for TasksForProject ───────────────────────────────

describe("DataTree (inside Tauri)", () => {
  type WithInternals = { __TAURI_INTERNALS__?: unknown };
  beforeEach(() => {
    (globalThis as WithInternals).__TAURI_INTERNALS__ = {};
    vi.resetModules();
    invokeMock.mockReset();
  });
  afterEach(() => {
    delete (globalThis as WithInternals).__TAURI_INTERNALS__;
  });

  it("loads tasks via listTasks IPC when expanded inside Tauri", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_tasks")
        return Promise.resolve([
          {
            id: "t1",
            projectId: "acme",
            name: "Backend task",
            archived: false,
          },
        ]);
      return Promise.resolve([]);
    });
    const { DataTree: FreshTree } = await import("./data-tree");
    render(
      <FreshTree
        projects={makeProjects()}
        clients={makeClients()}
        run={noopRun}
      />,
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: /expand acme-web/i })[0],
    );
    await waitFor(() => expect(screen.getByText("Backend task")).toBeTruthy());
    expect(invokeMock).toHaveBeenCalledWith("list_tasks", {
      projectId: "acme",
    });
  });

  it("falls back to empty list when listTasks IPC throws", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_tasks") return Promise.reject(new Error("db error"));
      return Promise.resolve([]);
    });
    const { DataTree: FreshTree } = await import("./data-tree");
    render(
      <FreshTree
        projects={makeProjects()}
        clients={makeClients()}
        run={noopRun}
      />,
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: /expand acme-web/i })[0],
    );
    await waitFor(() => expect(screen.getByText(/no tasks/i)).toBeTruthy());
  });

  it("saves a task via saveTask IPC when added inside Tauri", async () => {
    const savedTask = {
      id: "t-new",
      projectId: "acme",
      name: "IPC task",
      archived: false,
    };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_tasks") return Promise.resolve([]);
      if (cmd === "save_task") return Promise.resolve(savedTask);
      return Promise.resolve([]);
    });
    const { DataTree: FreshTree } = await import("./data-tree");
    render(
      <FreshTree
        projects={makeProjects()}
        clients={makeClients()}
        run={noopRun}
      />,
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: /expand acme-web/i })[0],
    );
    const input = await screen.findByLabelText(/new task for acme-web/i);
    fireEvent.change(input, { target: { value: "IPC task" } });
    fireEvent.click(screen.getAllByRole("button", { name: /^add$/i })[0]);
    await waitFor(() => expect(screen.getByText("IPC task")).toBeTruthy());
    expect(invokeMock).toHaveBeenCalledWith("save_task", {
      task: { projectId: "acme", name: "IPC task" },
    });
  });

  it("deletes a task via deleteTask IPC when confirmed inside Tauri", async () => {
    const existingTask = {
      id: "t-del",
      projectId: "acme",
      name: "Deletable",
      archived: false,
    };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_tasks") return Promise.resolve([existingTask]);
      if (cmd === "delete_task") return Promise.resolve(null);
      return Promise.resolve([]);
    });
    const { DataTree: FreshTree } = await import("./data-tree");
    render(
      <FreshTree
        projects={makeProjects()}
        clients={makeClients()}
        run={noopRun}
      />,
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: /expand acme-web/i })[0],
    );
    const deleteBtn = await screen.findByRole("button", {
      name: /delete deletable/i,
    });
    fireEvent.click(deleteBtn);
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("delete_task", { id: "t-del" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /delete deletable/i }),
      ).toBeNull(),
    );
  });
});
