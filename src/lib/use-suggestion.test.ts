import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const startEntryMock = vi.fn();
const snoozeRuleMock = vi.fn();
const snoozeAllMock = vi.fn();

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

function defaultOpts(overrides: Record<string, unknown> = {}) {
  return {
    startEntry: startEntryMock as never,
    snoozeRule: snoozeRuleMock as never,
    snoozeAll: snoozeAllMock as never,
    enabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  startEntryMock.mockReset();
  startEntryMock.mockResolvedValue({});
  snoozeRuleMock.mockReset();
  snoozeRuleMock.mockResolvedValue(undefined);
  snoozeAllMock.mockReset();
  snoozeAllMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useSuggestion (suggestive path)", () => {
  it("exposes the payload as `suggestion` for the banner to render", async () => {
    const { listen, harness } = makeListenHarness();
    const { useSuggestion } = await import("./use-suggestion");

    const { result } = renderHook(() =>
      useSuggestion(defaultOpts({ listen: listen as never })),
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
    expect(snoozeRuleMock).not.toHaveBeenCalled();
  });

  it("confirm() calls startEntry with source=rule and clears the suggestion", async () => {
    const { listen, harness } = makeListenHarness();
    const { useSuggestion } = await import("./use-suggestion");

    const { result } = renderHook(() =>
      useSuggestion(defaultOpts({ listen: listen as never })),
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

  it("dismiss() clears the suggestion and calls snoozeRule IPC with the default duration", async () => {
    const { listen, harness } = makeListenHarness();
    const { useSuggestion, DEFAULT_SNOOZE_SECONDS } = await import("./use-suggestion");

    const { result } = renderHook(() =>
      useSuggestion(defaultOpts({ listen: listen as never })),
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

    await act(async () => {
      await result.current.dismiss();
    });

    expect(result.current.suggestion).toBeNull();
    expect(snoozeRuleMock).toHaveBeenCalledTimes(1);
    expect(snoozeRuleMock).toHaveBeenCalledWith("r1", DEFAULT_SNOOZE_SECONDS);
  });

  it("dismiss() honours a caller-supplied snoozeSeconds", async () => {
    const { listen, harness } = makeListenHarness();
    const { useSuggestion } = await import("./use-suggestion");

    const { result } = renderHook(() =>
      useSuggestion(
        defaultOpts({ listen: listen as never, snoozeSeconds: 60 }),
      ),
    );

    await waitFor(() => expect(harness.handler).not.toBeNull());
    act(() => {
      harness.emit({
        ruleId: "r2",
        ruleName: "Other",
        confidence: "suggestive",
        project: "p",
        tags: [],
      });
    });

    await act(async () => {
      await result.current.dismiss();
    });
    expect(snoozeRuleMock).toHaveBeenCalledWith("r2", 60);
  });

  it("snoozeEverything() calls snoozeAll IPC and clears the suggestion", async () => {
    const { listen, harness } = makeListenHarness();
    const { useSuggestion } = await import("./use-suggestion");

    const { result } = renderHook(() =>
      useSuggestion(defaultOpts({ listen: listen as never })),
    );
    await waitFor(() => expect(harness.handler).not.toBeNull());
    act(() => {
      harness.emit({
        ruleId: "r3",
        ruleName: "x",
        confidence: "suggestive",
        project: "p",
        tags: [],
      });
    });

    await act(async () => {
      await result.current.snoozeEverything(3600);
    });

    expect(snoozeAllMock).toHaveBeenCalledWith(3600);
    expect(result.current.suggestion).toBeNull();
  });

  it("dismiss clears the banner BEFORE awaiting the IPC (no UI flicker on slow IPC)", async () => {
    // If `dismiss()` waited on the IPC before clearing the
    // banner, a slow IPC roundtrip would leave the banner
    // visible. Pin "set null first, IPC second" so this contract
    // doesn't silently regress.
    const { listen, harness } = makeListenHarness();
    const { useSuggestion } = await import("./use-suggestion");

    // Hold the snooze IPC open with a never-resolving promise so
    // we can observe the in-flight state.
    let resolveSnooze: () => void = () => {};
    snoozeRuleMock.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          resolveSnooze = r;
        }),
    );

    const { result } = renderHook(() =>
      useSuggestion(defaultOpts({ listen: listen as never })),
    );
    await waitFor(() => expect(harness.handler).not.toBeNull());
    act(() => {
      harness.emit({
        ruleId: "r-flicker",
        ruleName: "x",
        confidence: "suggestive",
        project: "p",
        tags: [],
      });
    });
    expect(result.current.suggestion).not.toBeNull();

    // Fire dismiss but don't await — the IPC promise is parked.
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.dismiss();
    });
    // Banner is already cleared even though the IPC is still in flight.
    expect(result.current.suggestion).toBeNull();
    expect(snoozeRuleMock).toHaveBeenCalledWith(
      "r-flicker",
      expect.any(Number),
    );

    // Resolve and await to keep the test lifecycle clean.
    resolveSnooze();
    await act(async () => {
      await pending;
    });
  });

  it("snoozeEverything() floors and clamps non-positive durations to 1 second", async () => {
    const { listen, harness } = makeListenHarness();
    const { useSuggestion } = await import("./use-suggestion");
    const { result } = renderHook(() =>
      useSuggestion(defaultOpts({ listen: listen as never })),
    );
    await waitFor(() => expect(harness.handler).not.toBeNull());

    await act(async () => {
      await result.current.snoozeEverything(0);
    });
    await act(async () => {
      await result.current.snoozeEverything(-100);
    });
    await act(async () => {
      await result.current.snoozeEverything(3600.7);
    });

    // 0 → 1, -100 → 1, 3600.7 → 3600 (floored)
    expect(snoozeAllMock).toHaveBeenNthCalledWith(1, 1);
    expect(snoozeAllMock).toHaveBeenNthCalledWith(2, 1);
    expect(snoozeAllMock).toHaveBeenNthCalledWith(3, 3600);
  });
});

describe("useSuggestion (strict path)", () => {
  it("auto-starts a timer and never sets suggestion state", async () => {
    const { listen, harness } = makeListenHarness();
    const { useSuggestion } = await import("./use-suggestion");

    const { result } = renderHook(() =>
      useSuggestion(defaultOpts({ listen: listen as never })),
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
    expect(snoozeRuleMock).not.toHaveBeenCalled();
  });

  it("does NOT re-fire when the same Strict rule already drives the running timer", async () => {
    const { listen, harness } = makeListenHarness();
    const { useSuggestion } = await import("./use-suggestion");

    renderHook(() =>
      useSuggestion(
        defaultOpts({
          listen: listen as never,
          currentRunningRuleId: "r-strict",
        }),
      ),
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
      useSuggestion(
        defaultOpts({
          listen: listen as never,
          currentRunningRuleId: "r-other",
        }),
      ),
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
});

describe("useSuggestion (disabled)", () => {
  it("does not subscribe to events outside a Tauri runtime", async () => {
    const { listen, harness } = makeListenHarness();
    const { useSuggestion } = await import("./use-suggestion");

    renderHook(() =>
      useSuggestion(defaultOpts({ listen: listen as never, enabled: false })),
    );

    expect(harness.handler).toBeNull();
    expect(startEntryMock).not.toHaveBeenCalled();
  });

  it("unlistens on unmount", async () => {
    const { listen, harness } = makeListenHarness();
    const { useSuggestion } = await import("./use-suggestion");

    const { unmount } = renderHook(() =>
      useSuggestion(defaultOpts({ listen: listen as never })),
    );
    await waitFor(() => expect(harness.handler).not.toBeNull());
    unmount();
    expect(harness.unlisten).toHaveBeenCalledTimes(1);
  });
});
