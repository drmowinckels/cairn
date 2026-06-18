import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

interface SuggestionFixture {
  ruleId: string;
  ruleName: string;
  confidence: "suggestive" | "strict";
  project: string | null;
  tags: string[];
  matchedSignals?: { signal: string; value: string }[];
}

const SUGGESTION_FIXTURE: SuggestionFixture = {
  ruleId: "r1",
  ruleName: "Cairn dev",
  confidence: "suggestive",
  project: "cairn",
  tags: ["dev"],
};
const confirmMock = vi.fn();
const dismissMock = vi.fn();
let suggestionOverride: SuggestionFixture | null = SUGGESTION_FIXTURE;

vi.mock("../../lib/use-suggestion", () => ({
  useSuggestion: () => ({
    suggestion: suggestionOverride,
    confirm: confirmMock,
    dismiss: dismissMock,
  }),
}));

import { TodayView } from "./index";

interface RenderArgs {
  layoutVariant?: "default" | "projects-first";
  hideSuggestion?: boolean;
}

function renderToday({
  layoutVariant = "default",
  hideSuggestion = false,
}: RenderArgs = {}) {
  suggestionOverride = hideSuggestion ? null : SUGGESTION_FIXTURE;
  const onOpenRule = vi.fn();
  const result = render(
    <TodayView
      density="comfy"
      layoutVariant={layoutVariant}
      onOpenRule={onOpenRule}
    />,
  );
  return { ...result, onOpenRule };
}

afterEach(() => {
  vi.clearAllMocks();
  suggestionOverride = SUGGESTION_FIXTURE;
  window.localStorage.clear();
});

describe("TodayView (idle — no running entry)", () => {
  it("renders the timer card in idle state with a Start control", () => {
    renderToday({ hideSuggestion: true });
    expect(screen.getByLabelText(/current timer/i)).toBeTruthy();
    expect(screen.getByText(/now · idle/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /start timer/i })).toBeTruthy();
  });

  it("renders the elapsed wrapper with aria-live polite", () => {
    const { container } = renderToday({ hideSuggestion: true });
    const elapsed = container.querySelector(".now-time");
    expect(elapsed?.getAttribute("aria-live")).toBe("polite");
  });

  it("shows a Start button (not Stop) when nothing is running", () => {
    renderToday({ hideSuggestion: true });
    expect(screen.getByRole("button", { name: /start timer/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /stop timer/i })).toBeNull();
  });

  it("idle state offers a project picker so a timer can be started with a project", () => {
    renderToday({ hideSuggestion: true });
    // The idle row renders the same project-picker chip used while running.
    expect(
      screen.getByRole("button", { name: /choose a project/i }),
    ).toBeTruthy();
  });

  it("renders the auto-detect suggestion banner when the hook surfaces a suggestion", () => {
    renderToday();
    expect(screen.getByLabelText(/auto-detected work/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^confirm$/i })).toBeTruthy();
    const body = document.querySelector(".suggest-body");
    expect(body?.textContent ?? "").toMatch(/Working on/);
    expect(body?.querySelector(".proj-chip-name")?.textContent).toBe("Cairn");
  });

  it("dismissing the banner calls the hook's dismiss() (which handles snooze)", () => {
    renderToday();
    fireEvent.click(
      screen.getByRole("button", { name: /dismiss suggestion/i }),
    );
    expect(dismissMock).toHaveBeenCalledTimes(1);
  });

  it("'Change…' dismisses the suggestion", () => {
    renderToday();
    fireEvent.click(screen.getByRole("button", { name: /change…/i }));
    expect(dismissMock).toHaveBeenCalledTimes(1);
  });

  it("clicking 'view rule' on the suggestion dismisses the banner and opens that rule", () => {
    const { onOpenRule } = renderToday();
    fireEvent.click(screen.getByRole("button", { name: /view rule/i }));
    expect(dismissMock).toHaveBeenCalledTimes(1);
    expect(onOpenRule).toHaveBeenCalledWith("r1");
  });

  it("renders the 'why' evidence chips from a suggestion carrying matchedSignals (#143)", () => {
    suggestionOverride = {
      ...SUGGESTION_FIXTURE,
      matchedSignals: [
        { signal: "git.branch", value: "feat/rules-ui" },
        { signal: "ide.folder", value: "~/code/cairn" },
      ],
    };
    const { container } = render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
      />,
    );
    const why = container.querySelector(".suggest-why");
    const codes = Array.from(why?.querySelectorAll("code") ?? []).map(
      (c) => c.textContent,
    );
    expect(codes).toEqual(["feat/rules-ui", "~/code/cairn"]);
    expect(why?.textContent ?? "").toContain("because");
  });

  it("renders no evidence chips when the suggestion carries no matchedSignals (#143)", () => {
    // SUGGESTION_FIXTURE has no matchedSignals — the banner still
    // renders, just without the "because …" line.
    const { container } = renderToday();
    const why = container.querySelector(".suggest-why");
    expect(why).not.toBeNull();
    expect(why?.querySelector("code")).toBeNull();
    expect(why?.textContent ?? "").not.toContain("because");
    // The "view rule" link is still present.
    expect(screen.getByRole("button", { name: /view rule/i })).toBeTruthy();
  });

  it("non-Escape keydown on the document does not dismiss the suggestion", () => {
    renderToday();
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(dismissMock).not.toHaveBeenCalled();
  });

  it("Escape keydown on the document dismisses the suggestion banner", () => {
    renderToday();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dismissMock).toHaveBeenCalledTimes(1);
  });

  it("clicking Confirm calls the hook's confirm()", () => {
    renderToday();
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    expect(confirmMock).toHaveBeenCalledTimes(1);
  });

  it("hides the suggestion banner when the hook returns suggestion=null", () => {
    renderToday({ hideSuggestion: true });
    expect(screen.queryByLabelText(/auto-detected work/i)).toBeNull();
  });

  it("renders the suggestion's tags from the live event payload", () => {
    renderToday();
    const tag = document.querySelector(".suggest-tags .tag");
    expect(tag?.textContent).toBe("#dev");
  });

  it("renders the timeline empty state when no entries exist today", () => {
    renderToday({ hideSuggestion: true });
    const empty = document.querySelector(".timeline .empty");
    expect(empty).toBeTruthy();
    expect(document.querySelectorAll(".dt-seg").length).toBe(0);
  });

  it("renders the recent-entries empty state in default layout (comfy density)", () => {
    renderToday();
    expect(screen.getByLabelText(/recent entries/i)).toBeTruthy();
    const recentEmpty = document.querySelector(".recent .empty");
    expect(recentEmpty).toBeTruthy();
  });

  it("toggles the entries surface between list and the vertical timeline (#188)", () => {
    const { container } = renderToday();
    // Defaults to the list (no timeline strip).
    expect(container.querySelector(".vt")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /timeline view/i }));
    expect(container.querySelector(".vt")).toBeTruthy();
    expect(document.querySelector(".recent .empty")).toBeNull();
    // And back to the list.
    fireEvent.click(screen.getByRole("button", { name: /list view/i }));
    expect(container.querySelector(".vt")).toBeNull();
    expect(document.querySelector(".recent .empty")).toBeTruthy();
  });

  it("falls back to the list (no Activity toggle) when 'activity' is persisted but the log is off (#190)", () => {
    // Persisted choice outlives the toggle being off → effective view is list.
    window.localStorage.setItem("cairn:today-entries-view:v1", "activity");
    const { container } = renderToday();
    expect(screen.queryByRole("button", { name: /activity view/i })).toBeNull();
    expect(container.querySelector(".act-review")).toBeNull();
    expect(document.querySelector(".recent .empty")).toBeTruthy();
  });

  it("renders the quick-start grid only in projects-first layout", () => {
    const { rerender } = renderToday();
    expect(screen.queryByLabelText(/quick-start a project/i)).toBeNull();

    rerender(
      <TodayView
        density="comfy"
        layoutVariant="projects-first"
        onOpenRule={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/quick-start a project/i)).toBeTruthy();
    expect(document.querySelectorAll(".quick-card").length).toBe(4);
  });

  it("renders the upcoming section with empty state outside Tauri", () => {
    const { container } = renderToday();
    // Outside Tauri calendarsConnected is forced true, so the section shows
    // its "nothing scheduled" empty state (useUpcoming returns no events).
    expect(container.querySelector(".upcoming")).toBeTruthy();
    expect(container.querySelectorAll(".up-item").length).toBe(0);
  });

  it("clicking a quick-start card calls timer.start (projects-first layout)", () => {
    renderToday({ layoutVariant: "projects-first" });
    const card = document.querySelector(".quick-card") as HTMLElement;
    expect(card).toBeTruthy();
    fireEvent.click(card);
  });
});

describe("TodayView (inside Tauri — running entry from backend)", () => {
  type WithInternals = { __TAURI_INTERNALS__?: unknown };

  beforeEach(() => {
    (globalThis as WithInternals).__TAURI_INTERNALS__ = {};
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as WithInternals).__TAURI_INTERNALS__;
  });

  async function freshRender(
    source: string,
    opts: { endedAt?: string | null } = {},
  ) {
    const running = {
      id: "e1",
      projectId: "cairn",
      taskId: null,
      description: "live work",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      endedAt: opts.endedAt ?? null,
      source,
      ruleId: source.startsWith("rule") ? "r1" : null,
    };
    const closed = {
      id: "e0",
      projectId: "cairn",
      taskId: null,
      description: "earlier",
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      endedAt: new Date(Date.now() - 120_000).toISOString(),
      source: "manual",
      ruleId: null,
    };
    const invoke = vi.fn(async (cmd: string, _args?: unknown) => {
      if (cmd === "current_running") return running;
      if (cmd === "list_day") return [closed, running];
      if (cmd === "list_projects")
        return [
          {
            id: "cairn",
            name: "Cairn",
            clientId: null,
            color: "#abc",
            archived: false,
          },
          {
            id: "ops",
            name: "Operations",
            clientId: null,
            color: "#9a9bb0",
            archived: false,
          },
        ];
      if (cmd === "stop_entry")
        return { ...running, endedAt: new Date().toISOString() };
      if (cmd === "update_entry") return { ...running, description: "patched" };
      return null;
    });
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    const { TodayView } = await import("./today");
    const utils = render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
      />,
    );
    return { ...utils, invoke };
  }

  for (const [source, expectedBadge] of [
    ["rule:branch=foo", "rule"],
    ["calendar", "calendar"],
    ["manual", "manual"],
  ] as const) {
    it(`labels the running timer source as '${expectedBadge}' for backend source='${source}'`, async () => {
      await freshRender(source);
      const badge = await screen.findByText(
        new RegExp(`^\\s*${expectedBadge}\\s*$`, "i"),
      );
      expect(badge).toBeTruthy();
      // #30: each source label is paired with its own glyph so the
      // distinction survives a grayscale / colorblind render.
      const wrapper = document.querySelector(".now-source");
      expect(wrapper?.querySelector("svg")).toBeTruthy();
    });
  }

  it("stop button is enabled when a backend entry is running and triggers stop_entry + list_day refetch", async () => {
    const { invoke } = await freshRender("manual");
    const stop = await screen.findByRole("button", { name: /stop timer/i });
    await waitFor(() => expect(stop.hasAttribute("disabled")).toBe(false));
    fireEvent.click(stop);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("stop_entry", { id: "e1" }),
    );
    await waitFor(() => {
      const todayCalls = invoke.mock.calls.filter(([c]) => c === "list_day");
      expect(todayCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("renders the timeline segments + 6 axis ticks + a running stripe class", async () => {
    await freshRender("manual");
    await waitFor(() => {
      const segments = document.querySelectorAll(".dt-seg");
      expect(segments.length).toBe(2);
    });
    expect(document.querySelectorAll(".dt-tick").length).toBe(6);
    expect(document.querySelectorAll(".dt-seg.is-running").length).toBe(1);
    expect(document.querySelector(".dt-now-label")).toBeTruthy();
  });

  it("clicking a vertical-timeline block opens the entry editor (#188)", async () => {
    await freshRender("manual");
    fireEvent.click(
      await screen.findByRole("button", { name: /timeline view/i }),
    );
    const block = await waitFor(() => {
      const b = document.querySelector<HTMLButtonElement>(
        ".vt-seg:not(:disabled)",
      );
      if (!b) throw new Error("no interactive block yet");
      return b;
    });
    fireEvent.click(block);
    expect(
      await screen.findByRole("dialog", { name: /edit entry/i }),
    ).toBeTruthy();
  });

  it("dragging a timeline block edge persists the new time via update_entry (#188)", async () => {
    const { invoke } = await freshRender("manual");
    fireEvent.click(
      await screen.findByRole("button", { name: /timeline view/i }),
    );
    const handle = await waitFor(() => {
      const h = document.querySelector<HTMLElement>(".vt-handle--bottom");
      if (!h) throw new Error("no resize handle yet");
      return h;
    });
    fireEvent.pointerDown(handle, { clientY: 100 });
    window.dispatchEvent(new MouseEvent("pointermove", { clientY: 144 }));
    window.dispatchEvent(new MouseEvent("pointerup"));
    await waitFor(() =>
      expect(invoke.mock.calls.some(([c]) => c === "update_entry")).toBe(true),
    );
  });

  it("a failed timeline resize is logged via console.error (#188 catch)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const closed = {
      id: "c1",
      projectId: "cairn",
      taskId: null,
      description: "earlier",
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      endedAt: new Date(Date.now() - 600_000).toISOString(),
      source: "manual",
      ruleId: null,
    };
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "current_running") return null;
      if (cmd === "list_day") return [closed];
      if (cmd === "list_projects")
        return [
          {
            id: "cairn",
            name: "Cairn",
            clientId: null,
            color: "#abc",
            archived: false,
          },
        ];
      if (cmd === "update_entry") throw new Error("resize boom");
      return null;
    });
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    const { TodayView } = await import("./today");
    render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /timeline view/i }),
    );
    const handle = await waitFor(() => {
      const h = document.querySelector<HTMLElement>(".vt-handle--bottom");
      if (!h) throw new Error("no resize handle yet");
      return h;
    });
    fireEvent.pointerDown(handle, { clientY: 100 });
    window.dispatchEvent(new MouseEvent("pointermove", { clientY: 144 }));
    window.dispatchEvent(new MouseEvent("pointerup"));
    await waitFor(() => expect(errSpy).toHaveBeenCalled());
    errSpy.mockRestore();
  });

  // Two adjacent closed entries in the same project, an hour apart, so the
  // timeline offers both split and merge over them.
  function twoAdjacentEntries() {
    const a = {
      id: "a",
      projectId: "cairn",
      taskId: null,
      description: "first",
      startedAt: new Date(Date.now() - 7_200_000).toISOString(),
      endedAt: new Date(Date.now() - 3_600_000).toISOString(),
      source: "manual",
      ruleId: null,
    };
    const b = {
      id: "b",
      projectId: "cairn",
      taskId: null,
      description: "second",
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      endedAt: new Date(Date.now() - 600_000).toISOString(),
      source: "manual",
      ruleId: null,
    };
    return { a, b };
  }

  function projectFixture() {
    return [
      {
        id: "cairn",
        name: "Cairn",
        clientId: null,
        color: "#abc",
        archived: false,
      },
    ];
  }

  it("splitting a block updates the original end + creates the second half (#188)", async () => {
    const { a } = twoAdjacentEntries();
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "current_running") return null;
      if (cmd === "list_day") return [a];
      if (cmd === "list_projects") return projectFixture();
      if (cmd === "update_entry") return { ...a };
      if (cmd === "create_entry") return { ...a, id: "a2" };
      return null;
    });
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    const { TodayView } = await import("./today");
    render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /timeline view/i }),
    );
    const block = await waitFor(() => {
      const b = document.querySelector<HTMLButtonElement>(
        ".vt-seg:not(:disabled)",
      );
      if (!b) throw new Error("no block yet");
      return b;
    });
    vi.spyOn(block, "getBoundingClientRect").mockReturnValue({
      top: 0,
      height: 100,
      bottom: 100,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    fireEvent.contextMenu(block, { clientY: 50 });
    fireEvent.click(await screen.findByRole("menuitem", { name: /split at/i }));
    await waitFor(() => {
      expect(invoke.mock.calls.some(([c]) => c === "update_entry")).toBe(true);
      expect(invoke.mock.calls.some(([c]) => c === "create_entry")).toBe(true);
    });
  });

  it("a failed split is logged via console.error (#188 catch)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { a } = twoAdjacentEntries();
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "current_running") return null;
      if (cmd === "list_day") return [a];
      if (cmd === "list_projects") return projectFixture();
      if (cmd === "update_entry") throw new Error("split boom");
      return null;
    });
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    const { TodayView } = await import("./today");
    render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /timeline view/i }),
    );
    const block = await waitFor(() => {
      const b = document.querySelector<HTMLButtonElement>(
        ".vt-seg:not(:disabled)",
      );
      if (!b) throw new Error("no block yet");
      return b;
    });
    vi.spyOn(block, "getBoundingClientRect").mockReturnValue({
      top: 0,
      height: 100,
      bottom: 100,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    fireEvent.contextMenu(block, { clientY: 50 });
    fireEvent.click(await screen.findByRole("menuitem", { name: /split at/i }));
    await waitFor(() => expect(errSpy).toHaveBeenCalled());
    errSpy.mockRestore();
  });

  it("merging two selected blocks extends one and deletes the other (#188)", async () => {
    const { a, b } = twoAdjacentEntries();
    const invoke = vi.fn(async (cmd: string, _args?: unknown) => {
      if (cmd === "current_running") return null;
      if (cmd === "list_day") return [a, b];
      if (cmd === "list_projects") return projectFixture();
      if (cmd === "update_entry") return { ...a };
      return null;
    });
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    const { TodayView } = await import("./today");
    render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /timeline view/i }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /select to merge/i }),
    );
    const blocks = await waitFor(() => {
      const bs = document.querySelectorAll<HTMLButtonElement>(".vt-seg");
      if (bs.length < 2) throw new Error("blocks not ready");
      return bs;
    });
    fireEvent.click(blocks[0]!);
    fireEvent.click(blocks[1]!);
    fireEvent.click(screen.getByRole("button", { name: /^merge$/i }));
    await waitFor(() => {
      expect(invoke.mock.calls.some(([c]) => c === "update_entry")).toBe(true);
      expect(
        invoke.mock.calls.some(
          ([c, args]) =>
            c === "delete_entry" && (args as { id: string }).id === "b",
        ),
      ).toBe(true);
    });
  });

  it("a failed merge is logged via console.error (#188 catch)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { a, b } = twoAdjacentEntries();
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "current_running") return null;
      if (cmd === "list_day") return [a, b];
      if (cmd === "list_projects") return projectFixture();
      if (cmd === "update_entry") throw new Error("merge boom");
      return null;
    });
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    const { TodayView } = await import("./today");
    render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /timeline view/i }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /select to merge/i }),
    );
    const blocks = await waitFor(() => {
      const bs = document.querySelectorAll<HTMLButtonElement>(".vt-seg");
      if (bs.length < 2) throw new Error("blocks not ready");
      return bs;
    });
    fireEvent.click(blocks[0]!);
    fireEvent.click(blocks[1]!);
    fireEvent.click(screen.getByRole("button", { name: /^merge$/i }));
    await waitFor(() => expect(errSpy).toHaveBeenCalled());
    errSpy.mockRestore();
  });

  it("offers the Activity view + renders recorded spans when the log is on (#190)", async () => {
    const span = {
      id: 1,
      startedAt: "2026-06-16T09:00:00+00:00",
      endedAt: "2026-06-16T09:30:00+00:00",
      appName: "Zoom",
      titleHint: "Standup",
      source: "window",
    };
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "current_running") return null;
      if (cmd === "list_day") return [];
      if (cmd === "list_projects")
        return [
          {
            id: "cairn",
            name: "Cairn",
            clientId: null,
            color: "#abc",
            archived: false,
          },
        ];
      if (cmd === "get_activity_log_settings")
        return { enabled: true, retentionDays: 7 };
      if (cmd === "list_activity_log") return [span];
      return null;
    });
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    const { TodayView } = await import("./today");
    render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
      />,
    );
    // The Activity toggle appears only because the log is enabled.
    fireEvent.click(
      await screen.findByRole("button", { name: /activity view/i }),
    );
    expect(await screen.findByText("Standup")).toBeTruthy();
  });

  it("timeline legend pairs each project dot with its name (#30 a11y dual-signal)", async () => {
    // Color is not the only signal: every dot in the legend must be
    // accompanied by the project's name so a grayscale render still
    // identifies which segment is which.
    await freshRender("manual");
    await waitFor(() => {
      expect(document.querySelectorAll(".legend-item").length).toBeGreaterThan(
        0,
      );
    });
    const items = document.querySelectorAll(".legend-item");
    for (const item of Array.from(items)) {
      expect(item.querySelector(".proj-dot")).toBeTruthy();
      // The trailing text node after the dot carries the project
      // name — strip the dot's empty text content to assert the
      // remainder is non-empty.
      const text = item.textContent?.trim() ?? "";
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it("hides the 'Up next' section entirely when no calendar is connected", async () => {
    await freshRender("manual");
    await waitFor(() => {
      expect(document.querySelectorAll(".dt-seg").length).toBe(2);
    });
    // freshRender leaves list_calendar_sources unhandled (returns null), so
    // no source is enabled — the upcoming section should not render at all.
    expect(document.querySelector(".upcoming")).toBeNull();
  });

  it("debounced description edits call update_entry after a quiet period", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { invoke } = await freshRender("manual");
      const input = (await screen.findByLabelText(
        /task description/i,
      )) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "new desc 1" } });
      fireEvent.change(input, { target: { value: "new desc 2" } });
      await vi.advanceTimersByTimeAsync(450);
      await waitFor(() => {
        const updates = invoke.mock.calls.filter(([c]) => c === "update_entry");
        expect(updates.length).toBe(1);
        expect(updates[0][1]).toEqual({
          input: { id: "e1", description: "new desc 2" },
        });
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("clicking outside the open project picker closes it", async () => {
    await freshRender("manual");
    const chip = await screen.findByRole("button", {
      name: /project: cairn\. change project/i,
    });
    fireEvent.click(chip);
    expect(screen.queryByRole("listbox")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });

  it("description input onBlur flushes the pending debounced update", async () => {
    const { invoke } = await freshRender("manual");
    const input = (await screen.findByLabelText(
      /task description/i,
    )) as HTMLInputElement;
    invoke.mockClear();
    fireEvent.change(input, { target: { value: "flush me" } });
    fireEvent.blur(input);
    await waitFor(() => {
      const updates = invoke.mock.calls.filter(([c]) => c === "update_entry");
      expect(updates.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("clicking the project chip opens a listbox of projects and picking one calls update_entry", async () => {
    const { invoke } = await freshRender("manual");
    const chip = await screen.findByRole("button", {
      name: /project: cairn\. change project/i,
    });
    fireEvent.click(chip);
    const list = await screen.findByRole("listbox");
    expect(list).toBeTruthy();
    const opsOpt = screen.getByRole("option", { name: /operations/i });
    fireEvent.click(opsOpt.querySelector("button") as HTMLElement);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("update_entry", {
        input: { id: "e1", projectId: "ops" },
      }),
    );
  });

  it("mousedown inside the picker does NOT close it (target contained by ref)", async () => {
    await freshRender("manual");
    const chip = await screen.findByRole("button", {
      name: /project: cairn\. change project/i,
    });
    fireEvent.click(chip);
    const list = await screen.findByRole("listbox");
    expect(list).toBeTruthy();
    fireEvent.mouseDown(list);
    expect(screen.queryByRole("listbox")).toBeTruthy();
  });

  it("debounced update rejection is logged via console.error (catch branch)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let updateShouldFail = false;
      const running = {
        id: "e1",
        projectId: "cairn",
        taskId: null,
        description: "live work",
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        endedAt: null,
        source: "manual",
        ruleId: null,
      };
      const invoke = vi.fn(async (cmd: string) => {
        if (cmd === "current_running") return running;
        if (cmd === "list_day") return [running];
        if (cmd === "list_projects")
          return [
            {
              id: "cairn",
              name: "Cairn",
              clientId: null,
              color: "#abc",
              archived: false,
            },
          ];
        if (cmd === "update_entry") {
          if (updateShouldFail) throw new Error("update boom");
          return running;
        }
        return null;
      });
      vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
      const { TodayView } = await import("./today");
      render(
        <TodayView
          density="comfy"
          layoutVariant="default"
          onOpenRule={vi.fn()}
        />,
      );
      const input = (await screen.findByLabelText(
        /task description/i,
      )) as HTMLInputElement;
      updateShouldFail = true;
      fireEvent.change(input, { target: { value: "trigger failure" } });
      await vi.advanceTimersByTimeAsync(450);
      await waitFor(() =>
        expect(errSpy).toHaveBeenCalledWith(
          "update_entry failed",
          expect.any(Error),
        ),
      );
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("project-pick rejection is logged via console.error (onPickProject catch)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const running = {
        id: "e1",
        projectId: "cairn",
        taskId: null,
        description: "live work",
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        endedAt: null,
        source: "manual",
        ruleId: null,
      };
      const invoke = vi.fn(async (cmd: string) => {
        if (cmd === "current_running") return running;
        if (cmd === "list_day") return [running];
        if (cmd === "list_projects")
          return [
            {
              id: "cairn",
              name: "Cairn",
              clientId: null,
              color: "#abc",
              archived: false,
            },
            {
              id: "ops",
              name: "Operations",
              clientId: null,
              color: "#def",
              archived: false,
            },
          ];
        if (cmd === "update_entry") throw new Error("pick boom");
        return null;
      });
      vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
      const { TodayView } = await import("./today");
      render(
        <TodayView
          density="comfy"
          layoutVariant="default"
          onOpenRule={vi.fn()}
        />,
      );
      const chip = await screen.findByRole("button", {
        name: /project: cairn\. change project/i,
      });
      fireEvent.click(chip);
      const opsOpt = await screen.findByRole("option", { name: /operations/i });
      fireEvent.click(opsOpt.querySelector("button") as HTMLElement);
      await waitFor(() =>
        expect(errSpy).toHaveBeenCalledWith(
          "update_entry failed",
          expect.any(Error),
        ),
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it("quick-start rejection is logged via console.error (start catch)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const invoke = vi.fn(async (cmd: string) => {
        if (cmd === "current_running") return null;
        if (cmd === "list_day") return [];
        if (cmd === "list_projects")
          return [
            {
              id: "cairn",
              name: "Cairn",
              clientId: null,
              color: "#abc",
              archived: false,
            },
          ];
        if (cmd === "start_entry") throw new Error("start boom");
        return null;
      });
      vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
      const { TodayView } = await import("./today");
      render(
        <TodayView
          density="comfy"
          layoutVariant="projects-first"
          onOpenRule={vi.fn()}
        />,
      );
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("current_running"),
      );
      const card = (await waitFor(() => {
        const c = document.querySelector(".quick-card");
        expect(c).toBeTruthy();
        return c as HTMLElement;
      })) as HTMLElement;
      fireEvent.click(card);
      await waitFor(() => {
        const calls = invoke.mock.calls.filter(([c]) => c === "start_entry");
        expect(calls.length).toBeGreaterThanOrEqual(1);
      });
      await waitFor(() =>
        expect(errSpy).toHaveBeenCalledWith("start failed", expect.any(Error)),
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it("idle Start button invokes start_entry (default layout, no Quick start)", async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "current_running") return null;
      if (cmd === "list_day") return [];
      if (cmd === "list_projects")
        return [
          {
            id: "cairn",
            name: "Cairn",
            clientId: null,
            color: "#abc",
            archived: false,
          },
        ];
      if (cmd === "start_entry")
        return {
          id: "new",
          projectId: null,
          taskId: null,
          description: "",
          startedAt: new Date().toISOString(),
          endedAt: null,
          source: "manual",
          ruleId: null,
        };
      return null;
    });
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    const { TodayView } = await import("./today");
    render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
      />,
    );
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("current_running"));
    const startBtn = await screen.findByRole("button", {
      name: /start timer/i,
    });
    fireEvent.click(startBtn);
    await waitFor(() => {
      const calls = invoke.mock.calls.filter(([c]) => c === "start_entry");
      expect(calls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("renders the picker fallback labels when no project is selected", async () => {
    const running = {
      id: "e1",
      projectId: null,
      taskId: null,
      description: "no project",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      endedAt: null,
      source: "manual",
      ruleId: null,
    };
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "current_running") return running;
      if (cmd === "list_day") return [running];
      if (cmd === "list_projects")
        return [
          {
            id: "cairn",
            name: "Cairn",
            clientId: null,
            color: "#abc",
            archived: false,
          },
        ];
      return null;
    });
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    const { TodayView } = await import("./today");
    render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole("button", { name: /choose a project/i }),
    ).toBeTruthy();
    const chipName = document.querySelector(".now-picker .proj-chip-name");
    expect(chipName?.textContent).toBe("No project");
  });

  it("renders Recent / Timeline entries that have no projectId (null branch)", async () => {
    const orphan = {
      id: "e-orphan",
      projectId: null,
      taskId: null,
      description: "uncategorized work",
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      endedAt: new Date(Date.now() - 120_000).toISOString(),
      source: "manual",
      ruleId: null,
    };
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "current_running") return null;
      if (cmd === "list_day") return [orphan];
      if (cmd === "list_projects")
        return [
          {
            id: "cairn",
            name: "Cairn",
            clientId: null,
            color: "#abc",
            archived: false,
          },
        ];
      return null;
    });
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    const { TodayView } = await import("./today");
    render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(document.querySelectorAll(".dt-seg").length).toBe(1),
    );
    expect(screen.getByText(/uncategorized work/i)).toBeTruthy();
  });

  it("renders rule and calendar source icons in the Recent list", async () => {
    const ruleEntry = {
      id: "e-rule",
      projectId: "cairn",
      taskId: null,
      description: "rule work",
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      endedAt: new Date(Date.now() - 120_000).toISOString(),
      source: "rule:branch=foo",
      ruleId: "r1",
    };
    const calEntry = {
      ...ruleEntry,
      id: "e-cal",
      description: "cal event",
      source: "calendar",
      ruleId: null,
    };
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "current_running") return null;
      if (cmd === "list_day") return [ruleEntry, calEntry];
      if (cmd === "list_projects")
        return [
          {
            id: "cairn",
            name: "Cairn",
            clientId: null,
            color: "#abc",
            archived: false,
          },
        ];
      return null;
    });
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    const { TodayView } = await import("./today");
    render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(document.querySelectorAll(".entries .entry").length).toBe(2),
    );
    expect(document.querySelectorAll(".entry-src").length).toBe(2);
  });

  it("timeline aria-live is 'off' when announce={false}", async () => {
    const running = {
      id: "e1",
      projectId: "cairn",
      taskId: null,
      description: "quiet",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      endedAt: null,
      source: "manual",
      ruleId: null,
    };
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "current_running") return running;
      if (cmd === "list_day") return [running];
      if (cmd === "list_projects")
        return [
          {
            id: "cairn",
            name: "Cairn",
            clientId: null,
            color: "#abc",
            archived: false,
          },
        ];
      return null;
    });
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    const { TodayView } = await import("./today");
    render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
        announce={false}
      />,
    );
    await waitFor(() =>
      expect(document.querySelectorAll(".dt-seg").length).toBe(1),
    );
    const needle = document.querySelector(".dt-now");
    expect(needle?.getAttribute("aria-live")).toBe("off");
    const elapsed = document.querySelector(".now-time");
    expect(elapsed?.getAttribute("aria-live")).toBe("off");
  });

  it("Recent list resolves project via PROJECT_BY_ID when not in live projects", async () => {
    const entry = {
      id: "e-fixture",
      projectId: "cairn",
      taskId: null,
      description: "cairn work",
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      endedAt: new Date(Date.now() - 120_000).toISOString(),
      source: "manual",
      ruleId: null,
    };
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "current_running") return null;
      if (cmd === "list_day") return [entry];
      // live projects deliberately empty — useProjects falls back to fixture.
      if (cmd === "list_projects") return [];
      return null;
    });
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    const { TodayView } = await import("./today");
    render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(document.querySelectorAll(".entries .entry").length).toBe(1),
    );
    const dot = document.querySelector(
      ".entries .entry .proj-dot",
    ) as HTMLElement;
    expect(dot.getAttribute("style") ?? "").not.toContain("var(--ink-mute)");
  });

  it("DayTimeline falls back to --ink-mute when a segment's projectId is unknown", async () => {
    const orphan = {
      id: "e-ghost",
      projectId: "deleted-project",
      taskId: null,
      description: "ghost project work",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      endedAt: null,
      source: "manual",
      ruleId: null,
    };
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "current_running") return orphan;
      if (cmd === "list_day") return [orphan];
      if (cmd === "list_projects")
        return [
          {
            id: "cairn",
            name: "Cairn",
            clientId: null,
            color: "#abc",
            archived: false,
          },
        ];
      return null;
    });
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    const { TodayView } = await import("./today");
    render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(document.querySelectorAll(".dt-seg").length).toBe(1),
    );
    const seg = document.querySelector(".dt-seg") as HTMLElement;
    expect(seg.getAttribute("style") ?? "").toContain("var(--ink-mute)");
  });

  it("picker mousedown listener ignores events whose target is not a DOM Node", async () => {
    await freshRender("manual");
    const chip = await screen.findByRole("button", {
      name: /project: cairn\. change project/i,
    });
    fireEvent.click(chip);
    expect(screen.queryByRole("listbox")).toBeTruthy();
    const evt = new Event("mousedown", { bubbles: true });
    Object.defineProperty(evt, "target", { value: null, configurable: true });
    document.dispatchEvent(evt);
    expect(screen.queryByRole("listbox")).toBeTruthy();
  });

  it("project picker stays inert when useProjects yields [] (no fixture leak)", async () => {
    const running = {
      id: "e-pick",
      projectId: "cairn",
      taskId: null,
      description: "live",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      endedAt: null,
      source: "manual",
      ruleId: null,
    };
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "current_running") return running;
      if (cmd === "list_day") return [running];
      if (cmd === "list_projects") return [];
      return null;
    });
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    vi.doMock("../../lib/use-projects", () => ({
      useProjects: () => ({ projects: [], refresh: vi.fn(), create: vi.fn() }),
    }));
    try {
      const { TodayView } = await import("./today");
      render(
        <TodayView
          density="comfy"
          layoutVariant="default"
          onOpenRule={vi.fn()}
        />,
      );
      const chip = await screen.findByRole("button", {
        name: /choose a project/i,
      });
      expect(chip.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(chip);
      expect(screen.queryByRole("listbox")).toBeNull();
    } finally {
      vi.doUnmock("../../lib/use-projects");
    }
  });

  it("quick-start grid renders an empty state when useProjects yields []", async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "current_running") return null;
      if (cmd === "list_day") return [];
      if (cmd === "list_projects") return [];
      return null;
    });
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    vi.doMock("../../lib/use-projects", () => ({
      useProjects: () => ({ projects: [], refresh: vi.fn(), create: vi.fn() }),
    }));
    try {
      const { TodayView } = await import("./today");
      render(
        <TodayView
          density="comfy"
          layoutVariant="projects-first"
          onOpenRule={vi.fn()}
        />,
      );
      await waitFor(() =>
        expect(screen.getByText(/no projects yet/i)).toBeTruthy(),
      );
      expect(document.querySelectorAll(".quick-card").length).toBe(0);
    } finally {
      vi.doUnmock("../../lib/use-projects");
    }
  });

  it("suggestion banner is an assertive live region (not a dialog) when detectionPrompts=modal", () => {
    suggestionOverride = SUGGESTION_FIXTURE;
    render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
        detectionPrompts="modal"
      />,
    );
    // The "modal" style is visual only — a non-blocking inline
    // notification, never an actual dialog (no focus trap / aria-modal).
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const region = screen.getByRole("region", { name: /auto-detected work/i });
    expect(region.getAttribute("aria-live")).toBe("assertive");
  });

  it("suggestion banner renders generic 'Detected' label when suggestion has no project", () => {
    suggestionOverride = { ...SUGGESTION_FIXTURE, project: null };
    render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
      />,
    );
    const body = document.querySelector(".suggest-body");
    expect(body?.textContent ?? "").toMatch(/^Detected/);
  });

  it("renders the timer error banner and Retry calls timer.refresh", async () => {
    let firstCall = true;
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "current_running") {
        if (firstCall) {
          firstCall = false;
          throw new Error("db unreachable");
        }
        return null;
      }
      if (cmd === "list_day") return [];
      if (cmd === "list_projects") return [];
      return null;
    });
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    const { TodayView } = await import("./today");
    render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
      />,
    );
    const banner = await screen.findByText(/couldn't reach the local timer/i);
    expect(banner).toBeTruthy();
    const retry = screen.getByRole("button", { name: /try again/i });
    fireEvent.click(retry);
    await waitFor(() => {
      const calls = invoke.mock.calls.filter(([c]) => c === "current_running");
      expect(calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
