import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const startEntryMock = vi.fn();

// Minimal Tauri event harness: the test holds a reference to the
// handler the hook registers via `listen`, and emits payloads by
// invoking it directly. `listen` returns the unlisten fn the hook
// will call on unmount.
interface ListenHarness {
  handler: ((event: { payload: unknown }) => void) | null;
  unlisten: ReturnType<typeof vi.fn>;
  emit: (payload: unknown) => void;
}

function makeListenHarness(): {
  listen: (
    name: string,
    cb: (event: { payload: unknown }) => void,
  ) => Promise<() => void>;
  harness: ListenHarness;
} {
  const unlisten = vi.fn();
  const harness: ListenHarness = {
    handler: null,
    unlisten,
    emit: (payload) => {
      if (harness.handler) harness.handler({ payload });
    },
  };
  const listen = async (
    _name: string,
    cb: (event: { payload: unknown }) => void,
  ): Promise<() => void> => {
    harness.handler = cb;
    return () => unlisten();
  };
  return { listen, harness };
}

beforeEach(() => {
  startEntryMock.mockReset();
  startEntryMock.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useSuggestion (suggestive path)", () => {
  it("exposes the payload as `suggestion` for the banner to render", async () => {
    const { listen, harness } = makeListenHarness();
    const { useSuggestion } = await import("./use-suggestion");

    const { result } = renderHook(() =>
      useSuggestion({
        startEntry: startEntryMock as never,
        listen: listen as never,
        enabled: true,
      }),
    );

    await waitFor(() => expect(harness.handler).not.toBeNull());
    expect(result.current.suggestion).toBeNull();

    act(() => {
      harness.emit({
        ruleId: "r1",
        ruleName: "Cairn dev",
        confidence: "suggestive",
        project: "cairn",
        tags: ["dev"],
      });
    });

    expect(result.current.suggestion).toEqual({
      ruleId: "r1",
      ruleName: "Cairn dev",
      confidence: "suggestive",
      project: "cairn",
      tags: ["dev"],
    });
    expect(startEntryMock).not.toHaveBeenCalled();
  });

  it("confirm() calls startEntry with source=rule and clears the suggestion", async () => {
    const { listen, harness } = makeListenHarness();
    const { useSuggestion } = await import("./use-suggestion");

    const { result } = renderHook(() =>
      useSuggestion({
        startEntry: startEntryMock as never,
        listen: listen as never,
        enabled: true,
      }),
    );

    await waitFor(() => expect(harness.handler).not.toBeNull());
    act(() => {
      harness.emit({
        ruleId: "r1",
        ruleName: "Cairn dev",
        confidence: "suggestive",
        project: "cairn",
        tags: ["dev"],
      });
    });
    expect(result.current.suggestion).not.toBeNull();

    await act(async () => {
      await result.current.confirm();
    });

    expect(startEntryMock).toHaveBeenCalledTimes(1);
    expect(startEntryMock).toHaveBeenCalledWith({
      projectId: "cairn",
      source: "rule",
      ruleId: "r1",
    });
    expect(result.current.suggestion).toBeNull();
  });

  it("dismiss() clears the suggestion and snoozes that rule's future matches", async () => {
    // Mock Date.now() instead of fake timers — fake timers break
    // waitFor's polling. The hook reads Date.now() for snooze
    // bookkeeping; controlling it directly is enough.
    let now = 1_000_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);

    const { listen, harness } = makeListenHarness();
    const { useSuggestion } = await import("./use-suggestion");

    const { result } = renderHook(() =>
      useSuggestion({
        snoozeMs: 60_000,
        startEntry: startEntryMock as never,
        listen: listen as never,
        enabled: true,
      }),
    );

    await waitFor(() => expect(harness.handler).not.toBeNull());
    act(() => {
      harness.emit({
        ruleId: "r1",
        ruleName: "Cairn dev",
        confidence: "suggestive",
        project: "cairn",
        tags: [],
      });
    });
    expect(result.current.suggestion).not.toBeNull();

    act(() => result.current.dismiss());
    expect(result.current.suggestion).toBeNull();

    // Within the snooze window: same rule re-firing must NOT
    // resurface the banner.
    now += 30_000; // half the snooze
    act(() => {
      harness.emit({
        ruleId: "r1",
        ruleName: "Cairn dev",
        confidence: "suggestive",
        project: "cairn",
        tags: [],
      });
    });
    expect(result.current.suggestion).toBeNull();

    // A different rule firing in the same window is unaffected.
    act(() => {
      harness.emit({
        ruleId: "r2",
        ruleName: "Other",
        confidence: "suggestive",
        project: "other",
        tags: [],
      });
    });
    expect(result.current.suggestion?.ruleId).toBe("r2");

    // After the snooze expires the original rule may resurface.
    act(() => result.current.dismiss());
    now += 60_001;
    act(() => {
      harness.emit({
        ruleId: "r1",
        ruleName: "Cairn dev",
        confidence: "suggestive",
        project: "cairn",
        tags: [],
      });
    });
    expect(result.current.suggestion?.ruleId).toBe("r1");
    dateNow.mockRestore();
  });
});

describe("useSuggestion (strict path)", () => {
  it("auto-starts a timer and never sets suggestion state", async () => {
    const { listen, harness } = makeListenHarness();
    const { useSuggestion } = await import("./use-suggestion");

    const { result } = renderHook(() =>
      useSuggestion({
        startEntry: startEntryMock as never,
        listen: listen as never,
        enabled: true,
      }),
    );

    await waitFor(() => expect(harness.handler).not.toBeNull());
    act(() => {
      harness.emit({
        ruleId: "r-strict",
        ruleName: "ACME work",
        confidence: "strict",
        project: "acme",
        tags: [],
      });
    });

    expect(result.current.suggestion).toBeNull();
    await waitFor(() =>
      expect(startEntryMock).toHaveBeenCalledWith({
        projectId: "acme",
        source: "rule",
        ruleId: "r-strict",
      }),
    );
  });

  it("does NOT re-fire when the same Strict rule already drives the running timer", async () => {
    const { listen, harness } = makeListenHarness();
    const { useSuggestion } = await import("./use-suggestion");

    renderHook(() =>
      useSuggestion({
        startEntry: startEntryMock as never,
        listen: listen as never,
        currentRunningRuleId: "r-strict",
        enabled: true,
      }),
    );

    await waitFor(() => expect(harness.handler).not.toBeNull());
    act(() => {
      harness.emit({
        ruleId: "r-strict",
        ruleName: "ACME work",
        confidence: "strict",
        project: "acme",
        tags: [],
      });
    });

    expect(startEntryMock).not.toHaveBeenCalled();
  });

  it("re-fires when a DIFFERENT Strict rule fires than the one currently running", async () => {
    const { listen, harness } = makeListenHarness();
    const { useSuggestion } = await import("./use-suggestion");

    renderHook(() =>
      useSuggestion({
        startEntry: startEntryMock as never,
        listen: listen as never,
        currentRunningRuleId: "r-other",
        enabled: true,
      }),
    );

    await waitFor(() => expect(harness.handler).not.toBeNull());
    act(() => {
      harness.emit({
        ruleId: "r-strict",
        ruleName: "ACME work",
        confidence: "strict",
        project: "acme",
        tags: [],
      });
    });

    await waitFor(() => expect(startEntryMock).toHaveBeenCalledTimes(1));
    expect(startEntryMock).toHaveBeenCalledWith({
      projectId: "acme",
      source: "rule",
      ruleId: "r-strict",
    });
  });

  it("does not snooze the Strict path even if a same-id rule was dismissed earlier as Suggestive", async () => {
    // If a user dismissed a rule when it was Suggestive, then the
    // rule is upgraded to Strict (or it always was Strict and the
    // earlier dismissal was a different snapshot), the Strict
    // auto-start MUST NOT be silently suppressed by the snooze
    // map. The spec ties snooze to "dismissed suggestion", not to
    // "rule_id is in the map".
    const { listen, harness } = makeListenHarness();
    const { useSuggestion } = await import("./use-suggestion");

    const { result } = renderHook(() =>
      useSuggestion({
        startEntry: startEntryMock as never,
        listen: listen as never,
        enabled: true,
      }),
    );
    await waitFor(() => expect(harness.handler).not.toBeNull());

    // Dismiss r1 as Suggestive (snoozes it).
    act(() => {
      harness.emit({
        ruleId: "r1",
        ruleName: "Cairn dev",
        confidence: "suggestive",
        project: "cairn",
        tags: [],
      });
    });
    act(() => result.current.dismiss());

    // Same rule fires later as Strict — must auto-start.
    act(() => {
      harness.emit({
        ruleId: "r1",
        ruleName: "Cairn dev",
        confidence: "strict",
        project: "cairn",
        tags: [],
      });
    });

    await waitFor(() =>
      expect(startEntryMock).toHaveBeenCalledWith({
        projectId: "cairn",
        source: "rule",
        ruleId: "r1",
      }),
    );
  });
});

describe("useSuggestion (disabled)", () => {
  it("does not subscribe to events outside a Tauri runtime", async () => {
    const { listen, harness } = makeListenHarness();
    const { useSuggestion } = await import("./use-suggestion");

    renderHook(() =>
      useSuggestion({
        startEntry: startEntryMock as never,
        listen: listen as never,
        enabled: false,
      }),
    );

    expect(harness.handler).toBeNull();
    expect(startEntryMock).not.toHaveBeenCalled();
  });

  it("unlistens on unmount", async () => {
    const { listen, harness } = makeListenHarness();
    const { useSuggestion } = await import("./use-suggestion");

    const { unmount } = renderHook(() =>
      useSuggestion({
        startEntry: startEntryMock as never,
        listen: listen as never,
        enabled: true,
      }),
    );
    await waitFor(() => expect(harness.handler).not.toBeNull());
    unmount();
    expect(harness.unlisten).toHaveBeenCalledTimes(1);
  });
});
