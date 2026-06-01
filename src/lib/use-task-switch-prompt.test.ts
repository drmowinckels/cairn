import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTaskSwitchPrompt } from "./use-task-switch-prompt";
import type { TaskSwitchPrefs } from "./task-switch";
import type { BackendEntry } from "./ipc";
import type { RuleMatchEvent } from "./types";

const ON: TaskSwitchPrefs = {
  enabled: true,
  dwellSeconds: 60,
  throttleMinutes: 30,
};

const RUNNING: BackendEntry = {
  id: "e1",
  projectId: "acme",
  taskId: null,
  description: "",
  startedAt: "2026-06-01T09:00:00Z",
  endedAt: null,
  source: "manual",
  ruleId: "r-acme",
};

function matchEvent(over: Partial<RuleMatchEvent> = {}): RuleMatchEvent {
  return {
    ruleId: "r1",
    ruleName: "Cairn repo",
    confidence: "suggestive",
    ambiguityBehavior: "prompt",
    project: "cairn",
    tags: [],
    description: "On Cairn",
    ...over,
  };
}

/** Build a harness that captures the `signal:match` handler and a mutable
 *  clock so tests drive dwell/staleness deterministically. */
function harness(
  opts: {
    prefs?: TaskSwitchPrefs;
    running?: BackendEntry | null;
    staleMs?: number;
  } = {},
) {
  const clock = { t: 0 };
  let handler: ((e: { payload: RuleMatchEvent }) => void) | null = null;
  const unlisten = vi.fn();
  const listenFn = vi.fn(
    (_evt: string, h: (e: { payload: RuleMatchEvent }) => void) => {
      handler = h;
      return Promise.resolve(unlisten);
    },
  );
  const startEntry = vi.fn().mockResolvedValue(undefined);
  const snoozeRule = vi.fn().mockResolvedValue(undefined);
  const view = renderHook(
    (props: { prefs: TaskSwitchPrefs; running: BackendEntry | null }) =>
      useTaskSwitchPrompt({
        prefs: props.prefs,
        running: props.running,
        enabled: true,
        pollMs: 1_000,
        staleMs: opts.staleMs ?? 1_000_000,
        now: () => clock.t,
        listen: listenFn as never,
        startEntry: startEntry as never,
        snoozeRule: snoozeRule as never,
      }),
    {
      initialProps: {
        prefs: opts.prefs ?? ON,
        running: opts.running === undefined ? RUNNING : opts.running,
      },
    },
  );
  return {
    clock,
    fire: (m: RuleMatchEvent) => act(() => handler?.({ payload: m })),
    advance: (ms: number) =>
      act(() => {
        clock.t += ms;
        vi.advanceTimersByTime(ms);
      }),
    startEntry,
    snoozeRule,
    unlisten,
    listenFn,
    ...view,
  };
}

describe("useTaskSwitchPrompt", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function flush() {
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("prompts only after the candidate dwells past dwellSeconds", async () => {
    const h = harness();
    await flush();
    h.fire(matchEvent());
    h.advance(59_000);
    expect(h.result.current.active).toBeNull();
    h.advance(2_000);
    expect(h.result.current.active?.ruleId).toBe("r1");
  });

  it("never prompts while disabled", async () => {
    const h = harness({ prefs: { ...ON, enabled: false } });
    await flush();
    h.fire(matchEvent());
    h.advance(120_000);
    expect(h.result.current.active).toBeNull();
  });

  it("ignores a match for the project already running", async () => {
    const h = harness();
    await flush();
    h.fire(matchEvent({ project: "acme" }));
    h.advance(120_000);
    expect(h.result.current.active).toBeNull();
  });

  it("drops a candidate that stops matching before it dwells", async () => {
    const h = harness({ staleMs: 4_000 });
    await flush();
    h.fire(matchEvent());
    h.advance(5_000);
    expect(h.result.current.active).toBeNull();
    h.advance(120_000);
    expect(h.result.current.active).toBeNull();
  });

  it("auto-dismisses an active prompt once the candidate goes stale", async () => {
    const h = harness({ prefs: { ...ON, dwellSeconds: 2 }, staleMs: 4_000 });
    await flush();
    h.fire(matchEvent());
    h.advance(2_000);
    expect(h.result.current.active?.ruleId).toBe("r1");
    h.advance(5_000);
    expect(h.result.current.active).toBeNull();
  });

  it("clears an active prompt when the feature is turned off", async () => {
    const h = harness({ prefs: { ...ON, dwellSeconds: 2 } });
    await flush();
    h.fire(matchEvent());
    h.advance(2_000);
    expect(h.result.current.active?.ruleId).toBe("r1");
    act(() =>
      h.rerender({ prefs: { ...ON, enabled: false }, running: RUNNING }),
    );
    h.advance(1_000);
    expect(h.result.current.active).toBeNull();
  });

  it("throttles a second switch within the throttle window", async () => {
    const h = harness({ prefs: { ...ON, dwellSeconds: 2 } });
    await flush();
    h.fire(matchEvent());
    h.advance(2_000);
    act(() => void h.result.current.confirm());
    await flush();
    // A new candidate immediately after — within the 30-min throttle.
    h.fire(matchEvent({ ruleId: "r2", project: "beta" }));
    h.advance(2_000);
    expect(h.result.current.active).toBeNull();
  });

  it("confirm switches via start_entry and clears the prompt", async () => {
    const h = harness({ prefs: { ...ON, dwellSeconds: 2 } });
    await flush();
    h.fire(matchEvent());
    h.advance(2_000);
    await act(async () => {
      await h.result.current.confirm();
    });
    expect(h.startEntry).toHaveBeenCalledWith({
      projectId: "cairn",
      source: "rule",
      ruleId: "r1",
      description: "On Cairn",
    });
    expect(h.result.current.active).toBeNull();
  });

  it("confirm is a no-op when nothing is active", async () => {
    const h = harness();
    await flush();
    await act(async () => {
      await h.result.current.confirm();
    });
    expect(h.startEntry).not.toHaveBeenCalled();
  });

  it("confirm clears even when start_entry fails", async () => {
    const h = harness({ prefs: { ...ON, dwellSeconds: 2 } });
    h.startEntry.mockRejectedValueOnce(new Error("db locked"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await flush();
    h.fire(matchEvent());
    h.advance(2_000);
    await act(async () => {
      await h.result.current.confirm();
    });
    expect(h.result.current.active).toBeNull();
    expect(err).toHaveBeenCalled();
  });

  it("dismiss snoozes the rule and clears the prompt", async () => {
    const h = harness({ prefs: { ...ON, dwellSeconds: 2 } });
    await flush();
    h.fire(matchEvent());
    h.advance(2_000);
    act(() => h.result.current.dismiss());
    expect(h.snoozeRule).toHaveBeenCalledWith("r1", 5 * 60);
    expect(h.result.current.active).toBeNull();
  });

  it("dismiss is a no-op when nothing is active", async () => {
    const h = harness();
    await flush();
    act(() => h.result.current.dismiss());
    expect(h.snoozeRule).not.toHaveBeenCalled();
  });

  it("dismiss swallows a snooze failure", async () => {
    const h = harness({ prefs: { ...ON, dwellSeconds: 2 } });
    h.snoozeRule.mockRejectedValueOnce(new Error("nope"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await flush();
    h.fire(matchEvent());
    h.advance(2_000);
    act(() => h.result.current.dismiss());
    await flush();
    expect(h.result.current.active).toBeNull();
    expect(err).toHaveBeenCalled();
  });

  it("never prompts when no timer is running", async () => {
    const h = harness({ running: null });
    await flush();
    h.fire(matchEvent());
    h.advance(120_000);
    expect(h.result.current.active).toBeNull();
  });

  it("confirm omits an empty description", async () => {
    const h = harness({ prefs: { ...ON, dwellSeconds: 2 } });
    await flush();
    h.fire(matchEvent({ description: "" }));
    h.advance(2_000);
    await act(async () => {
      await h.result.current.confirm();
    });
    expect(h.startEntry).toHaveBeenCalledWith({
      projectId: "cairn",
      source: "rule",
      ruleId: "r1",
      description: undefined,
    });
  });

  it("uses default deps (no injected opts) and stays inactive outside Tauri", async () => {
    // No injected enabled/now/poll/listen/ipc: exercises every `?? default`
    // fallback. Outside Tauri `enabled` defaults to `inTauri` (false), so the
    // effect returns early and never reaches the real `listen`.
    const { result } = renderHook(() =>
      useTaskSwitchPrompt({ prefs: ON, running: RUNNING }),
    );
    await flush();
    expect(result.current.active).toBeNull();
  });

  it("unsubscribes if unmounted before the listener resolves", async () => {
    const h = harness();
    h.unmount();
    await flush();
    expect(h.unlisten).toHaveBeenCalled();
  });
});
