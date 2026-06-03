import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn(),
}));
vi.mock("../../lib/use-suggestion", () => ({
  useSuggestion: () => ({
    suggestion: null,
    confirm: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

import type { BackendEntry, BackendRule } from "../../lib/ipc";
import type { Project } from "../../lib/types";

type WithInternals = { __TAURI_INTERNALS__?: unknown };

const PROJECT: Project = {
  id: "p1",
  name: "Alpha",
  clientId: null,
  color: "#aaa",
  archived: false,
  estimateHours: null,
};

function ruleRow(over: Partial<BackendRule>): BackendRule {
  return {
    id: "r1",
    name: "Rule",
    enabled: true,
    priority: 10,
    body: {},
    ...over,
  };
}

function entryRow(over: Partial<BackendEntry>): BackendEntry {
  return {
    id: "e1",
    projectId: "p1",
    taskId: null,
    description: "",
    startedAt: "2026-06-02T09:00:00Z",
    endedAt: "2026-06-02T10:00:00Z",
    source: "manual",
    ruleId: null,
    ...over,
  };
}

interface Backend {
  today?: BackendEntry[];
  rules?: BackendRule[];
  projects?: Project[];
  running?: BackendEntry | null;
  startEntry?: () => Promise<BackendEntry>;
  stopEntry?: () => Promise<BackendEntry>;
  saveRule?: () => Promise<BackendRule>;
}

async function mountPopover(backend: Backend) {
  const { invoke } = await import("@tauri-apps/api/core");
  (invoke as ReturnType<typeof vi.fn>).mockImplementation(
    async (cmd: string) => {
      switch (cmd) {
        case "get_onboarding_state":
          return { completedAt: "2026-01-01T00:00:00Z" };
        case "list_today":
          return backend.today ?? [];
        case "list_rules":
          return backend.rules ?? [];
        case "start_entry":
          if (backend.startEntry) return backend.startEntry();
          return entryRow({ endedAt: null });
        case "stop_entry":
          if (backend.stopEntry) return backend.stopEntry();
          return entryRow({});
        case "save_rule":
          if (backend.saveRule) return backend.saveRule();
          return backend.rules?.[0] ?? ruleRow({});
        case "current_running":
          return backend.running ?? null;
        case "list_projects":
          return backend.projects ?? [];
        case "signal_capture_status":
          return { active: false };
        default:
          // Arrays for any list_* command so consumers that `.map`
          // over the result don't crash; null for everything else
          // (singletons / status objects the popover tolerates).
          if (cmd.startsWith("list_")) return [];
          return null;
      }
    },
  );
  const { Popover } = await import("./popover");
  render(<Popover />);
  await waitFor(() =>
    expect(
      screen.getByRole("dialog", { name: /cairn time tracker/i }),
    ).toBeTruthy(),
  );
}

describe("Popover footer — live totals (#142)", () => {
  let original: unknown;

  beforeEach(() => {
    localStorage.clear();
    original = (globalThis as WithInternals).__TAURI_INTERNALS__;
    (globalThis as WithInternals).__TAURI_INTERNALS__ = {};
    vi.resetModules();
  });

  afterEach(() => {
    if (original === undefined) {
      delete (globalThis as WithInternals).__TAURI_INTERNALS__;
    } else {
      (globalThis as WithInternals).__TAURI_INTERNALS__ = original;
    }
    vi.clearAllMocks();
  });

  it("renders today's summed total and the active-rule count from live data", async () => {
    await mountPopover({
      today: [
        entryRow({
          startedAt: "2026-06-02T09:00:00Z",
          endedAt: "2026-06-02T10:00:00Z",
        }),
        entryRow({
          id: "e2",
          startedAt: "2026-06-02T11:00:00Z",
          endedAt: "2026-06-02T11:30:00Z",
        }),
      ],
      rules: [
        ruleRow({ id: "r1", enabled: true }),
        ruleRow({ id: "r2", enabled: true }),
        ruleRow({ id: "r3", enabled: false }),
      ],
    });

    const footer = document.querySelector(".pop-foot") as HTMLElement;
    await waitFor(() => expect(footer.textContent).toMatch(/1h 30m today/));
    expect(footer.textContent).toMatch(/2 rules active/);
    // The old hardcoded fixture copy must be gone.
    expect(footer.textContent).not.toMatch(/4h 12m/);
    expect(footer.textContent).not.toMatch(/3 rules active/);
  });

  it("pluralizes a single active rule", async () => {
    await mountPopover({
      today: [],
      rules: [
        ruleRow({ id: "r1", enabled: true }),
        ruleRow({ id: "r2", enabled: false }),
      ],
    });
    const footer = document.querySelector(".pop-foot") as HTMLElement;
    await waitFor(() => expect(footer.textContent).toMatch(/1 rule active/));
    expect(footer.textContent).not.toMatch(/1 rules active/);
  });

  it("omits the today total until entries have loaded (no fake zero flash)", async () => {
    // Hold `list_today` open so the popover renders with the timer
    // resolved but today still loading.
    let releaseToday!: (rows: BackendEntry[]) => void;
    const pending = new Promise<BackendEntry[]>((r) => {
      releaseToday = r;
    });
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as ReturnType<typeof vi.fn>).mockImplementation(
      async (cmd: string) => {
        switch (cmd) {
          case "get_onboarding_state":
            return { completedAt: "2026-01-01T00:00:00Z" };
          case "list_today":
            return pending;
          case "list_rules":
            return [ruleRow({ id: "r1", enabled: true })];
          case "signal_capture_status":
            return { active: false };
          default:
            if (cmd.startsWith("list_")) return [];
            return null;
        }
      },
    );
    const { Popover } = await import("./popover");
    render(<Popover />);
    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: /cairn time tracker/i }),
      ).toBeTruthy(),
    );
    const footer = document.querySelector(".pop-foot") as HTMLElement;
    // Rules loaded, but today is still pending: no "… today" yet.
    await waitFor(() => expect(footer.textContent).toMatch(/1 rule active/));
    expect(footer.textContent).not.toMatch(/today/);

    releaseToday([
      entryRow({
        startedAt: "2026-06-02T09:00:00Z",
        endedAt: "2026-06-02T09:20:00Z",
      }),
    ]);
    await waitFor(() => expect(footer.textContent).toMatch(/20m today/));
  });
});

describe("Popover — palette action errors surface in the chrome (#142)", () => {
  let original: unknown;

  beforeEach(() => {
    localStorage.clear();
    original = (globalThis as WithInternals).__TAURI_INTERNALS__;
    (globalThis as WithInternals).__TAURI_INTERNALS__ = {};
    vi.resetModules();
  });

  afterEach(() => {
    if (original === undefined) {
      delete (globalThis as WithInternals).__TAURI_INTERNALS__;
    } else {
      (globalThis as WithInternals).__TAURI_INTERNALS__ = original;
    }
    vi.clearAllMocks();
  });

  it("shows an error banner + announces when a palette start-timer rejects", async () => {
    const { fireEvent } = await import("@testing-library/react");
    await mountPopover({
      today: [],
      rules: [],
      projects: [PROJECT],
      startEntry: () => Promise.reject(new Error("database is locked")),
    });

    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    const input = await screen.findByRole("textbox", {
      name: /command palette/i,
    });
    fireEvent.change(input, { target: { value: "start timer" } });
    const cmd = await screen.findAllByText(/Start timer for/i);
    fireEvent.click(cmd[0]);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/database is locked/);
    await waitFor(() =>
      expect(screen.getByTestId("cairn-announcer").textContent).toMatch(
        /database is locked/,
      ),
    );
  });

  it("surfaces a swallowed stop-timer failure via the timer-error effect", async () => {
    // `useTimer.stop` catches the rejection and exposes it as hook
    // `error` rather than rejecting, so the palette dispatch's
    // `.catch` never fires — the popover's timer-error effect is what
    // routes it to the chrome banner.
    const { fireEvent } = await import("@testing-library/react");
    await mountPopover({
      today: [],
      rules: [],
      projects: [PROJECT],
      running: entryRow({ id: "running-1", endedAt: null }),
      stopEntry: () => Promise.reject(new Error("stop failed: io error")),
    });

    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    const input = await screen.findByRole("textbox", {
      name: /command palette/i,
    });
    fireEvent.change(input, { target: { value: "stop running timer" } });
    fireEvent.click(await screen.findByText(/Stop running timer/i));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/stop failed: io error/);
  });

  it("surfaces a swallowed rule-toggle failure via the rules-error effect", async () => {
    // `useRules.update` swallows the rejection into hook `error`; the
    // popover's rules-error effect mirrors it into the chrome banner.
    const { fireEvent } = await import("@testing-library/react");
    await mountPopover({
      today: [],
      rules: [ruleRow({ id: "r1", name: "Cairn dev", enabled: true })],
      projects: [PROJECT],
      saveRule: () => Promise.reject(new Error("save rule failed")),
    });

    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    const input = await screen.findByRole("textbox", {
      name: /command palette/i,
    });
    fireEvent.change(input, { target: { value: "rule" } });
    fireEvent.click(await screen.findByText(/(Enable|Disable) rule:/i));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/save rule failed/);
  });
});
