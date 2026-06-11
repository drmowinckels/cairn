import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { buildCommands, CommandPalette, type PaletteContext } from "./palette";
import type { Project, Rule } from "../../lib/types";
import { createMruStore } from "../../lib/use-palette";

const PROJECTS: Project[] = [
  {
    id: "alpha",
    name: "Alpha",
    clientId: null,
    color: "#aaa",
    archived: false,
    estimateHours: null,
  },
  {
    id: "beta",
    name: "Beta",
    clientId: null,
    color: "#bbb",
    archived: false,
    estimateHours: null,
  },
  {
    id: "gamma",
    name: "Gamma",
    clientId: null,
    color: "#ccc",
    archived: false,
    estimateHours: null,
  },
];

const RULES: Rule[] = [
  {
    id: "r1",
    name: "Cairn dev work",
    enabled: true,
    priority: 10,
    when: [],
    then: { project: "alpha" },
    matchedToday: 0,
  },
  {
    id: "r2",
    name: "ACME meetings",
    enabled: false,
    priority: 20,
    when: [],
    then: { project: "beta" },
    matchedToday: 0,
  },
];

function baseContext(overrides: Partial<PaletteContext> = {}): PaletteContext {
  return {
    view: "today",
    running: null,
    projects: PROJECTS,
    rules: RULES,
    setView: vi.fn(),
    openSettingsSection: vi.fn(),
    startTimer: vi.fn(),
    stopTimer: vi.fn(),
    switchProject: vi.fn(),
    toggleRule: vi.fn(),
    revealDataFolder: vi.fn(),
    addEntry: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildCommands — surfaced commands", () => {
  it("surfaces 'Add manual entry' and runs the addEntry action", () => {
    const addEntry = vi.fn();
    const cmds = buildCommands(baseContext({ addEntry }));
    const cmd = cmds.find((c) => c.label === "Add manual entry");
    expect(cmd).toBeTruthy();
    cmd?.run();
    expect(addEntry).toHaveBeenCalledTimes(1);
  });

  it("includes 'Start timer for X' for every project when no timer is running", () => {
    const cmds = buildCommands(baseContext({ running: null }));
    const labels = cmds.map((c) => c.label);
    for (const p of PROJECTS) {
      expect(labels).toContain(`Start timer for ${p.name}`);
    }
    // No 'Stop' when nothing is running.
    expect(labels).not.toContain("Stop running timer");
  });

  it("includes 'Switch running timer to X' for every other project when running", () => {
    const cmds = buildCommands(
      baseContext({
        running: { id: "r-1", projectId: "alpha" },
      }),
    );
    const labels = cmds.map((c) => c.label);
    expect(labels).toContain("Switch running timer to Beta");
    expect(labels).toContain("Switch running timer to Gamma");
    expect(labels).not.toContain("Switch running timer to Alpha");
    expect(labels).toContain("Stop running timer");
    // Start-* is suppressed while a timer is running.
    expect(labels).not.toContain("Start timer for Alpha");
  });

  it("includes 'Switch view' for every view except the current one", () => {
    const cmds = buildCommands(baseContext({ view: "today" }));
    const labels = cmds.map((c) => c.label);
    expect(labels).toContain("Switch view: Reports");
    expect(labels).toContain("Switch view: Rules");
    expect(labels).toContain("Switch view: Settings");
    expect(labels).toContain("Switch view: Extensions");
    expect(labels).not.toContain("Switch view: Today");
  });

  it("includes 'Open settings: ' for each canonical settings section", () => {
    const cmds = buildCommands(baseContext());
    const labels = cmds.map((c) => c.label);
    for (const s of [
      "Privacy",
      "Accessibility",
      "Shortcuts",
      "Updates",
      "Diagnostics",
    ]) {
      expect(labels).toContain(`Open settings: ${s}`);
    }
    // Moved out of Settings: exclusions → Rules, integrations/calendar →
    // Extensions, about → the tray window.
    expect(labels).not.toContain("Open settings: Never track these");
    expect(labels).not.toContain("Open settings: Integrations");
    expect(labels).not.toContain("Open settings: About");
  });

  it("the Updates command opens the updates settings section", () => {
    const openSettingsSection = vi.fn();
    const cmds = buildCommands(baseContext({ openSettingsSection }));
    const updates = cmds.find((c) => c.label === "Open settings: Updates");
    expect(updates).toBeTruthy();
    updates?.run();
    expect(openSettingsSection).toHaveBeenCalledWith("updates");
  });

  it("includes 'Disable rule' for enabled rules and 'Enable rule' for disabled rules", () => {
    const cmds = buildCommands(baseContext());
    const labels = cmds.map((c) => c.label);
    expect(labels).toContain("Disable rule: Cairn dev work");
    expect(labels).toContain("Enable rule: ACME meetings");
  });

  it("always includes 'Open log file'", () => {
    const cmds = buildCommands(baseContext());
    expect(cmds.some((c) => c.id === "open-log-file")).toBe(true);
  });

  it("each command has a unique id", () => {
    const cmds = buildCommands(
      baseContext({ running: { id: "r1", projectId: "alpha" } }),
    );
    const ids = cmds.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("dispatch — switchProject() runs the matching command", () => {
    const switchProject = vi.fn();
    const cmds = buildCommands(
      baseContext({
        running: { id: "r-1", projectId: "alpha" },
        switchProject,
      }),
    );
    const cmd = cmds.find((c) => c.id === "switch-project:beta");
    expect(cmd).toBeDefined();
    void cmd!.run();
    expect(switchProject).toHaveBeenCalledWith("beta");
  });

  it("dispatch — startTimer() runs from start-project command", () => {
    const startTimer = vi.fn();
    const cmds = buildCommands(baseContext({ startTimer }));
    const cmd = cmds.find((c) => c.id === "start-project:gamma");
    void cmd!.run();
    expect(startTimer).toHaveBeenCalledWith("gamma");
  });

  it("dispatch — stopTimer() runs from the stop command", () => {
    const stopTimer = vi.fn();
    const cmds = buildCommands(
      baseContext({
        running: { id: "r-1", projectId: "alpha" },
        stopTimer,
      }),
    );
    const cmd = cmds.find((c) => c.id === "stop-timer");
    void cmd!.run();
    expect(stopTimer).toHaveBeenCalled();
  });

  it("dispatch — toggleRule() flips the enabled state", () => {
    const toggleRule = vi.fn();
    const cmds = buildCommands(baseContext({ toggleRule }));
    const cmd = cmds.find((c) => c.id === "toggle-rule:r1");
    void cmd!.run();
    expect(toggleRule).toHaveBeenCalledWith("r1", false);

    const cmd2 = cmds.find((c) => c.id === "toggle-rule:r2");
    void cmd2!.run();
    expect(toggleRule).toHaveBeenCalledWith("r2", true);
  });

  it("dispatch — revealDataFolder() runs from open-log-file", () => {
    const revealDataFolder = vi.fn();
    const cmds = buildCommands(baseContext({ revealDataFolder }));
    const cmd = cmds.find((c) => c.id === "open-log-file");
    void cmd!.run();
    expect(revealDataFolder).toHaveBeenCalled();
  });

  it("dispatch — openSettingsSection() routes the right section", () => {
    const openSettingsSection = vi.fn();
    const cmds = buildCommands(baseContext({ openSettingsSection }));
    const cmd = cmds.find((c) => c.id === "settings:privacy");
    void cmd!.run();
    expect(openSettingsSection).toHaveBeenCalledWith("privacy");
  });

  it("dispatch — setView() switches view", () => {
    const setView = vi.fn();
    const cmds = buildCommands(baseContext({ setView }));
    const cmd = cmds.find((c) => c.id === "view:rules");
    void cmd!.run();
    expect(setView).toHaveBeenCalledWith("rules");
  });
});

describe("CommandPalette — rendering & accessibility", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <CommandPalette open={false} onClose={vi.fn()} context={baseContext()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders as a modal dialog with aria-modal and a listbox", () => {
    render(<CommandPalette open onClose={vi.fn()} context={baseContext()} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("focuses the input on open", async () => {
    render(<CommandPalette open onClose={vi.fn()} context={baseContext()} />);
    await new Promise((r) => window.requestAnimationFrame(r));
    expect(document.activeElement?.tagName).toBe("INPUT");
  });

  it("each visible item has role='option'", () => {
    render(<CommandPalette open onClose={vi.fn()} context={baseContext()} />);
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
  });

  it("filters items via fuzzy match on the query", () => {
    render(<CommandPalette open onClose={vi.fn()} context={baseContext()} />);
    const input = screen.getByLabelText(/command palette/i);
    fireEvent.change(input, { target: { value: "alpha" } });
    const labels = screen.getAllByRole("option").map((o) => o.textContent);
    expect(labels.some((l) => l?.includes("Alpha"))).toBe(true);
    expect(labels.every((l) => !l?.includes("Beta"))).toBe(true);
  });

  it("shows 'No matching commands.' when nothing matches", () => {
    render(<CommandPalette open onClose={vi.fn()} context={baseContext()} />);
    const input = screen.getByLabelText(/command palette/i);
    fireEvent.change(input, { target: { value: "zzz-no-such-cmd" } });
    expect(screen.getByText(/no matching commands/i)).toBeTruthy();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });
});

describe("CommandPalette — keyboard", () => {
  it("Esc closes the palette", () => {
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} context={baseContext()} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ArrowDown moves the highlight to the next item", () => {
    render(<CommandPalette open onClose={vi.fn()} context={baseContext()} />);
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    const options = screen.getAllByRole("option");
    expect(options[1].getAttribute("aria-selected")).toBe("true");
  });

  it("ArrowUp moves the highlight back", () => {
    render(<CommandPalette open onClose={vi.fn()} context={baseContext()} />);
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    fireEvent.keyDown(dialog, { key: "ArrowUp" });
    const options = screen.getAllByRole("option");
    expect(options[1].getAttribute("aria-selected")).toBe("true");
  });

  it("Home / End jump to the ends of the list", () => {
    render(<CommandPalette open onClose={vi.fn()} context={baseContext()} />);
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "End" });
    const options = screen.getAllByRole("option");
    expect(options[options.length - 1].getAttribute("aria-selected")).toBe(
      "true",
    );
    fireEvent.keyDown(dialog, { key: "Home" });
    expect(options[0].getAttribute("aria-selected")).toBe("true");
  });

  it("ArrowDown clamps at the last item", () => {
    render(<CommandPalette open onClose={vi.fn()} context={baseContext()} />);
    const dialog = screen.getByRole("dialog");
    const options = screen.getAllByRole("option");
    for (let i = 0; i < options.length + 5; i++) {
      fireEvent.keyDown(dialog, { key: "ArrowDown" });
    }
    expect(options[options.length - 1].getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("ArrowUp clamps at the first item", () => {
    render(<CommandPalette open onClose={vi.fn()} context={baseContext()} />);
    const dialog = screen.getByRole("dialog");
    for (let i = 0; i < 5; i++) {
      fireEvent.keyDown(dialog, { key: "ArrowUp" });
    }
    const options = screen.getAllByRole("option");
    expect(options[0].getAttribute("aria-selected")).toBe("true");
  });

  it("Enter executes the highlighted command + closes", async () => {
    const setView = vi.fn();
    const onClose = vi.fn();
    render(
      <CommandPalette
        open
        onClose={onClose}
        context={baseContext({ setView })}
      />,
    );
    const input = screen.getByLabelText(/command palette/i);
    fireEvent.change(input, { target: { value: "reports" } });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    expect(onClose).toHaveBeenCalled();
    await new Promise((r) => window.requestAnimationFrame(r));
    expect(setView).toHaveBeenCalledWith("reports");
  });

  it("Enter on an empty list is a no-op (no close)", () => {
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} context={baseContext()} />);
    const input = screen.getByLabelText(/command palette/i);
    fireEvent.change(input, { target: { value: "zzz-no-such-cmd" } });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("clicking an item executes it", async () => {
    const setView = vi.fn();
    const onClose = vi.fn();
    render(
      <CommandPalette
        open
        onClose={onClose}
        context={baseContext({ setView })}
      />,
    );
    const input = screen.getByLabelText(/command palette/i);
    fireEvent.change(input, { target: { value: "rules" } });
    const opt = screen
      .getAllByRole("option")
      .find((o) => /Rules/.test(o.textContent ?? ""))!;
    fireEvent.click(opt);
    expect(onClose).toHaveBeenCalled();
    await new Promise((r) => window.requestAnimationFrame(r));
    expect(setView).toHaveBeenCalledWith("rules");
  });

  it("overlay click closes the palette", () => {
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} context={baseContext()} />);
    const overlay = document.querySelector(".palette-overlay") as HTMLElement;
    fireEvent.mouseDown(overlay);
    expect(onClose).toHaveBeenCalled();
  });

  it("mousedown inside the dialog does not close", () => {
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} context={baseContext()} />);
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("non-navigation keys (e.g. letter input) fall through without preventDefault", () => {
    render(<CommandPalette open onClose={vi.fn()} context={baseContext()} />);
    const dialog = screen.getByRole("dialog");
    const evt = fireEvent.keyDown(dialog, { key: "a" });
    // fireEvent returns true unless an event was prevented.
    expect(evt).toBe(true);
  });

  it("hover over an item updates the highlight (mouseEnter)", () => {
    render(<CommandPalette open onClose={vi.fn()} context={baseContext()} />);
    const options = screen.getAllByRole("option");
    fireEvent.mouseEnter(options[2]);
    expect(options[2].getAttribute("aria-selected")).toBe("true");
  });
});

describe("CommandPalette — MRU behaviour", () => {
  it("bumps the MRU on execute", async () => {
    const store = createMruStore();
    const setView = vi.fn();
    render(
      <CommandPalette
        open
        onClose={vi.fn()}
        context={baseContext({ setView })}
        mruStore={store}
      />,
    );
    const input = screen.getByLabelText(/command palette/i);
    fireEvent.change(input, { target: { value: "reports" } });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    expect(store.read()[0]).toBe("view:reports");
  });

  it("shows MRU-ordered commands at the top when query is empty", () => {
    const store = createMruStore();
    store.bump("view:settings");
    render(
      <CommandPalette
        open
        onClose={vi.fn()}
        context={baseContext()}
        mruStore={store}
      />,
    );
    const options = screen.getAllByRole("option");
    expect(options[0].textContent).toContain("Switch view: Settings");
  });

  it("query overrides MRU ordering", () => {
    const store = createMruStore();
    store.bump("view:settings");
    render(
      <CommandPalette
        open
        onClose={vi.fn()}
        context={baseContext()}
        mruStore={store}
      />,
    );
    const input = screen.getByLabelText(/command palette/i);
    fireEvent.change(input, { target: { value: "rules" } });
    const options = screen.getAllByRole("option");
    expect(options[0].textContent).toContain("Rules");
  });
});

describe("CommandPalette — focus trap + return", () => {
  it("focus stays inside the dialog when Tabbing from the last focusable", async () => {
    render(<CommandPalette open onClose={vi.fn()} context={baseContext()} />);
    const dialog = screen.getByRole("dialog");
    // Only the input is tabbable inside the dialog (the listbox is
    // navigated by arrows, not Tab), so Tab cycles back to itself.
    const input = dialog.querySelector("input") as HTMLElement;
    input.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(input);
  });

  it("Shift+Tab on the first focusable also stays on the input", () => {
    render(<CommandPalette open onClose={vi.fn()} context={baseContext()} />);
    const dialog = screen.getByRole("dialog");
    const input = dialog.querySelector("input") as HTMLElement;
    input.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(input);
  });

  it("resets query and highlight on each open transition", async () => {
    const { rerender } = render(
      <CommandPalette open onClose={vi.fn()} context={baseContext()} />,
    );
    const input = screen.getByLabelText(/command palette/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello" } });
    expect(input.value).toBe("hello");
    rerender(
      <CommandPalette open={false} onClose={vi.fn()} context={baseContext()} />,
    );
    rerender(<CommandPalette open onClose={vi.fn()} context={baseContext()} />);
    const input2 = screen.getByLabelText(
      /command palette/i,
    ) as HTMLInputElement;
    expect(input2.value).toBe("");
  });

  it("clamps highlight when commands collapse below the current index", () => {
    render(<CommandPalette open onClose={vi.fn()} context={baseContext()} />);
    const dialog = screen.getByRole("dialog");
    act(() => {
      for (let i = 0; i < 10; i++)
        fireEvent.keyDown(dialog, { key: "ArrowDown" });
    });
    const input = screen.getByLabelText(/command palette/i);
    // Narrow the list to one item.
    fireEvent.change(input, { target: { value: "log file" } });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0].getAttribute("aria-selected")).toBe("true");
  });
});

describe("CommandPalette — action errors", () => {
  // The dispatch defers `run()` into a rAF, then resolves it through a
  // promise chain, so a rejection needs one rAF + a couple of
  // microtask turns to reach the `.catch`.
  async function flushDispatch() {
    await new Promise((r) => window.requestAnimationFrame(r));
    await Promise.resolve();
    await Promise.resolve();
  }

  function runFirstStartCommand(onActionError: (m: string) => void) {
    const input = screen.getByLabelText(/command palette/i);
    fireEvent.change(input, { target: { value: "start timer" } });
    const opt = screen
      .getAllByRole("option")
      .find((o) => /Start timer for/.test(o.textContent ?? ""))!;
    fireEvent.click(opt);
    return onActionError;
  }

  it("routes a rejected action to onActionError with the command label", async () => {
    const onActionError = vi.fn();
    const startTimer = vi.fn().mockRejectedValue(new Error("db is locked"));
    render(
      <CommandPalette
        open
        onClose={vi.fn()}
        context={baseContext({ startTimer })}
        onActionError={onActionError}
      />,
    );
    runFirstStartCommand(onActionError);
    await flushDispatch();
    expect(startTimer).toHaveBeenCalled();
    expect(onActionError).toHaveBeenCalledTimes(1);
    const message = onActionError.mock.calls[0][0] as string;
    expect(message).toMatch(/Start timer for/);
    expect(message).toMatch(/db is locked/);
  });

  it("routes a rejected switchProject action to onActionError with the label", async () => {
    const onActionError = vi.fn();
    const switchProject = vi
      .fn()
      .mockRejectedValue(new Error("switch failed: io error"));
    render(
      <CommandPalette
        open
        onClose={vi.fn()}
        context={baseContext({
          running: { id: "r-1", projectId: "alpha" },
          switchProject,
        })}
        onActionError={onActionError}
      />,
    );
    const input = screen.getByLabelText(/command palette/i);
    fireEvent.change(input, { target: { value: "switch running timer" } });
    const opt = screen
      .getAllByRole("option")
      .find((o) => /Switch running timer to/.test(o.textContent ?? ""))!;
    fireEvent.click(opt);
    await flushDispatch();
    expect(switchProject).toHaveBeenCalled();
    expect(onActionError).toHaveBeenCalledTimes(1);
    const message = onActionError.mock.calls[0][0] as string;
    expect(message).toMatch(/Switch running timer to/);
    expect(message).toMatch(/switch failed: io error/);
  });

  it("stringifies a non-Error rejection value", async () => {
    const onActionError = vi.fn();
    const startTimer = vi.fn().mockRejectedValue("boom");
    render(
      <CommandPalette
        open
        onClose={vi.fn()}
        context={baseContext({ startTimer })}
        onActionError={onActionError}
      />,
    );
    runFirstStartCommand(onActionError);
    await flushDispatch();
    expect(onActionError).toHaveBeenCalledTimes(1);
    expect(onActionError.mock.calls[0][0]).toMatch(/boom/);
  });

  it("does not call onActionError when the action resolves", async () => {
    const onActionError = vi.fn();
    const startTimer = vi.fn().mockResolvedValue(undefined);
    render(
      <CommandPalette
        open
        onClose={vi.fn()}
        context={baseContext({ startTimer })}
        onActionError={onActionError}
      />,
    );
    runFirstStartCommand(onActionError);
    await flushDispatch();
    expect(startTimer).toHaveBeenCalled();
    expect(onActionError).not.toHaveBeenCalled();
  });

  it("swallows a rejection harmlessly when no onActionError is provided", async () => {
    const startTimer = vi.fn().mockRejectedValue(new Error("nope"));
    render(
      <CommandPalette
        open
        onClose={vi.fn()}
        context={baseContext({ startTimer })}
      />,
    );
    const input = screen.getByLabelText(/command palette/i);
    fireEvent.change(input, { target: { value: "start timer" } });
    const opt = screen
      .getAllByRole("option")
      .find((o) => /Start timer for/.test(o.textContent ?? ""))!;
    fireEvent.click(opt);
    await flushDispatch();
    expect(startTimer).toHaveBeenCalled();
  });
});
