import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

// The popover transitively mounts Reports / Settings which both call
// useBackup, which dynamically imports the dialog + opener plugins.
// Mock at the top level so the module factory wins over the consumer
// imports.
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

// The popover transitively mounts Today which renders the
// suggestion banner via useSuggestion(). Mock the hook with a
// fixed Suggestive match so the "view rule" / dismissal flows
// have something to click on.
vi.mock("../../lib/use-suggestion", () => ({
  useSuggestion: () => ({
    suggestion: {
      ruleId: "r1",
      ruleName: "Cairn dev",
      confidence: "suggestive" as const,
      project: "cairn",
      tags: ["dev"],
    },
    confirm: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

import { Popover } from "./popover";

beforeEach(() => {
  document.body.removeAttribute("data-theme");
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Popover shell", () => {
  it("renders dialog landmarks: header, nav, body, footer", () => {
    render(<Popover />);
    expect(
      screen.getByRole("dialog", { name: /cairn time tracker/i }),
    ).toBeTruthy();
    expect(screen.getByRole("tablist", { name: /cairn views/i })).toBeTruthy();
    expect(screen.getByRole("tabpanel")).toBeTruthy();
  });

  it("renders all four tabs with the right active state", () => {
    render(<Popover initialView="reports" />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(4);
    const labels = tabs.map((t) => t.textContent?.trim());
    expect(labels).toEqual([
      expect.stringMatching(/today/i),
      expect.stringMatching(/reports/i),
      expect.stringMatching(/rules/i),
      expect.stringMatching(/settings/i),
    ]);
    const reportsTab = tabs.find((t) => /reports/i.test(t.textContent ?? ""))!;
    expect(reportsTab.getAttribute("aria-selected")).toBe("true");
  });

  it("clicking a tab switches the active view", () => {
    render(<Popover />);
    const rulesTab = screen
      .getAllByRole("tab")
      .find((t) => /rules/i.test(t.textContent ?? ""))!;
    fireEvent.click(rulesTab);
    expect(rulesTab.getAttribute("aria-selected")).toBe("true");
    // Rules view landmark
    expect(screen.getByRole("heading", { name: /^rules$/i })).toBeTruthy();
  });

  it("keyboard shortcuts 1-4 switch views (outside input/textarea)", () => {
    render(<Popover />);
    fireEvent.keyDown(window, { key: "2" });
    expect(screen.getByRole("heading", { name: /this week/i })).toBeTruthy();
    fireEvent.keyDown(window, { key: "3" });
    expect(screen.getByRole("heading", { name: /^rules$/i })).toBeTruthy();
    fireEvent.keyDown(window, { key: "4" });
    expect(screen.getByRole("heading", { name: /your data stays here/i })).toBeTruthy();
    fireEvent.keyDown(window, { key: "1" });
    // Today view doesn't have a heading-level title, so check the timeline label.
    expect(screen.getByText(/today's path/i)).toBeTruthy();
  });

  it("keyboard shortcut is ignored when an INPUT has focus", () => {
    render(<Popover />);
    // Mount a focused input to simulate the user typing in any text
    // field — the popover's global shortcut handler must defer to it.
    const probe = document.createElement("input");
    document.body.appendChild(probe);
    try {
      probe.focus();
      fireEvent.keyDown(probe, { key: "3" });
      // Still on Today
      expect(screen.getByText(/today's path/i)).toBeTruthy();
    } finally {
      document.body.removeChild(probe);
    }
  });

  it("applies the persisted theme to the document root on mount", () => {
    // Theme is owned by useA11yPrefs (persisted), not a Popover prop.
    // Default pref is "system" → resolves to light here (happy-dom
    // reports no dark preference). The full theme matrix is covered in
    // use-a11y-prefs.test.tsx.
    render(<Popover />);
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("renders the LocalBadge in the header with the privacy tooltip", () => {
    render(<Popover />);
    const badge = document.querySelector(".local-badge");
    expect(badge?.getAttribute("title")).toContain("stays on your machine");
  });

  it("opens the rules view with the matching rule expanded when 'view rule' is clicked from a suggestion", () => {
    render(<Popover />);
    const link = screen.getByRole("button", { name: /view rule/i });
    fireEvent.click(link);
    expect(screen.getByRole("heading", { name: /^rules$/i })).toBeTruthy();
  });
});

describe("Density propagation", () => {
  it("applies data-density on the root popover", () => {
    const { container, rerender } = render(<Popover density="compact" />);
    expect(container.querySelector(".pop")?.getAttribute("data-density")).toBe(
      "compact",
    );
    rerender(<Popover density="comfy" />);
    expect(container.querySelector(".pop")?.getAttribute("data-density")).toBe(
      "comfy",
    );
  });
});

describe("Global ambiguity default → new rule (#71)", () => {
  beforeEach(() => {
    // Each test starts from a clean a11y pref blob so the localStorage
    // load doesn't drag state from a sibling test.
    localStorage.clear();
  });

  it("changing the default in Settings is honoured by a New rule in Rules (end-to-end)", async () => {
    // Reviewer asked for the user-visible flow: open Settings, flip
    // the radio, switch to Rules, click "New", assert the new rule's
    // ambiguity `<select>` shows the new default. Exercises the
    // `useA11yPrefs` → `Popover` → `RulesView` → `useRules` →
    // `blankRule` chain in one shot — the seam the per-layer tests
    // skip past.
    render(<Popover initialView="settings" ruleComplexity="heavy" />);

    // 1) Settings → flip "Default ambiguity behaviour" to Uncategorized.
    const group = screen.getByRole("radiogroup", {
      name: /default ambiguity behaviour/i,
    });
    const uncategorized = Array.from(
      group.querySelectorAll<HTMLElement>('[role="radio"]'),
    ).find((b) => b.textContent === "Uncategorized")!;
    expect(uncategorized).toBeTruthy();
    fireEvent.click(uncategorized);

    // 2) Switch to Rules.
    const rulesTab = screen
      .getAllByRole("tab")
      .find((t) => /rules/i.test(t.textContent ?? ""))!;
    fireEvent.click(rulesTab);

    // 3) Click "New rule" — async (the hook's add() resolves on the
    //    next microtask).
    fireEvent.click(screen.getByRole("button", { name: /new rule/i }));

    // 4) The newly-expanded rule's ambiguity select should reflect
    //    the new default. The id is generated; query by class +
    //    open-rule scope. Wait for the optimistic add + auto-expand
    //    to commit.
    await waitFor(() => {
      const sel = document.querySelector<HTMLSelectElement>(
        ".rule.is-open select.rule-amb",
      );
      expect(sel?.value).toBe("log-to-uncategorized");
    });
  });
});

describe("Popover — first-run onboarding gating (#31)", () => {
  let original: unknown;
  type WithInternals = { __TAURI_INTERNALS__?: unknown };

  beforeEach(() => {
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
  });

  it("renders the onboarding overlay when the backend reports completedAt=null", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as ReturnType<typeof vi.fn>).mockImplementation(
      async (cmd: string) => {
        if (cmd === "get_onboarding_state") return { completedAt: null };
        return null;
      },
    );
    const { Popover } = await import("./popover");
    render(<Popover />);
    let dialog!: HTMLElement;
    await waitFor(() => {
      dialog = screen.getByRole("dialog", { name: /first-run onboarding/i });
      expect(dialog).toBeTruthy();
    });
    expect(screen.getByText(/welcome to cairn/i)).toBeTruthy();
    // The onboarding overlay is position:absolute (out of flow), so .pop has no
    // in-flow children and collapses unless this attribute pins its height
    // (brand.css .pop[data-onboarding]). Without it the popover renders blank.
    expect(dialog.getAttribute("data-onboarding")).toBe("true");
  });

  it("renders the normal popover when completedAt is set", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as ReturnType<typeof vi.fn>).mockImplementation(
      async (cmd: string) => {
        if (cmd === "get_onboarding_state")
          return { completedAt: "2026-01-01T00:00:00Z" };
        return null;
      },
    );
    const { Popover } = await import("./popover");
    render(<Popover />);
    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: /cairn time tracker/i }),
      ).toBeTruthy(),
    );
  });
});

describe("Popover header — add-entry button (#21)", () => {
  it("clicking the header + button opens the manual-entry modal on Today", async () => {
    render(<Popover />);
    const plus = screen.getByRole("button", { name: /add manual entry/i });
    fireEvent.click(plus);
    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: /new entry/i }),
      ).toBeTruthy(),
    );
  });

  it("opening from a non-Today view switches to Today first", async () => {
    render(<Popover />);
    const rulesTab = screen
      .getAllByRole("tab")
      .find((t) => /rules/i.test(t.textContent ?? ""))!;
    fireEvent.click(rulesTab);
    expect(rulesTab.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(
      screen.getByRole("button", { name: /add manual entry/i }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: /new entry/i }),
      ).toBeTruthy(),
    );
    const todayTab = screen
      .getAllByRole("tab")
      .find((t) => /today/i.test(t.textContent ?? ""))!;
    expect(todayTab.getAttribute("aria-selected")).toBe("true");
  });
});
