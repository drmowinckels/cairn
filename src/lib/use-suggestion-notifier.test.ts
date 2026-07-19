import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { useSuggestionNotifier } from "./use-suggestion-notifier";
import type { RuleMatchEvent } from "./types";

const SUGGESTIVE: RuleMatchEvent = {
  ruleId: "r1",
  ruleName: "Cairn dev",
  confidence: "suggestive",
  ambiguityBehavior: "prompt",
  project: "cairn",
  tags: [],
  description: "",
};

function fakeListen() {
  let emit: ((e: { payload: RuleMatchEvent }) => void) | undefined;
  const listen = vi.fn(
    async (_name: string, cb: (e: { payload: RuleMatchEvent }) => void) => {
      emit = cb;
      return () => {};
    },
  );
  return {
    listen: listen as never,
    emit: (payload: RuleMatchEvent) => {
      act(() => emit?.({ payload }));
    },
  };
}

afterEach(() => vi.clearAllMocks());

describe("useSuggestionNotifier", () => {
  it("shows the notification for a suggestive + prompt match when enabled", async () => {
    const { listen, emit } = fakeListen();
    const show = vi.fn().mockResolvedValue(undefined);
    renderHook(() =>
      useSuggestionNotifier({
        enabled: true,
        runtimeEnabled: true,
        listen,
        showSuggestionNotification: show as never,
      }),
    );
    emit(SUGGESTIVE);
    await vi.waitFor(() => expect(show).toHaveBeenCalledWith(SUGGESTIVE));
  });

  it("does not show when disabled (tier is not 'notification')", () => {
    const { listen, emit } = fakeListen();
    const show = vi.fn().mockResolvedValue(undefined);
    renderHook(() =>
      useSuggestionNotifier({
        enabled: false,
        runtimeEnabled: true,
        listen,
        showSuggestionNotification: show as never,
      }),
    );
    emit(SUGGESTIVE);
    expect(show).not.toHaveBeenCalled();
  });

  it("ignores strict matches (left to useSuggestion's auto-start)", () => {
    const { listen, emit } = fakeListen();
    const show = vi.fn().mockResolvedValue(undefined);
    renderHook(() =>
      useSuggestionNotifier({
        enabled: true,
        runtimeEnabled: true,
        listen,
        showSuggestionNotification: show as never,
      }),
    );
    emit({ ...SUGGESTIVE, confidence: "strict" });
    expect(show).not.toHaveBeenCalled();
  });

  it("ignores 'skip' ambiguity matches", () => {
    const { listen, emit } = fakeListen();
    const show = vi.fn().mockResolvedValue(undefined);
    renderHook(() =>
      useSuggestionNotifier({
        enabled: true,
        runtimeEnabled: true,
        listen,
        showSuggestionNotification: show as never,
      }),
    );
    emit({ ...SUGGESTIVE, ambiguityBehavior: "skip" });
    expect(show).not.toHaveBeenCalled();
  });

  it("ignores 'log-to-uncategorized' ambiguity matches (left to useSuggestion)", () => {
    const { listen, emit } = fakeListen();
    const show = vi.fn().mockResolvedValue(undefined);
    renderHook(() =>
      useSuggestionNotifier({
        enabled: true,
        runtimeEnabled: true,
        listen,
        showSuggestionNotification: show as never,
      }),
    );
    emit({ ...SUGGESTIVE, ambiguityBehavior: "log-to-uncategorized" });
    expect(show).not.toHaveBeenCalled();
  });

  it("reflects a toggled 'enabled' without re-subscribing", async () => {
    const { listen, emit } = fakeListen();
    const show = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(
      (enabled: boolean) =>
        useSuggestionNotifier({
          enabled,
          runtimeEnabled: true,
          listen,
          showSuggestionNotification: show as never,
        }),
      { initialProps: false },
    );
    emit(SUGGESTIVE);
    expect(show).not.toHaveBeenCalled();

    rerender(true);
    emit(SUGGESTIVE);
    await vi.waitFor(() => expect(show).toHaveBeenCalledWith(SUGGESTIVE));
    // Only one subscription across both renders — toggling `enabled` is
    // read live via a ref, not by re-subscribing the listener.
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it("logs but does not throw when show_suggestion_notification rejects", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { listen, emit } = fakeListen();
    const show = vi.fn().mockRejectedValue(new Error("boom"));
    renderHook(() =>
      useSuggestionNotifier({
        enabled: true,
        runtimeEnabled: true,
        listen,
        showSuggestionNotification: show as never,
      }),
    );
    emit(SUGGESTIVE);
    await vi.waitFor(() =>
      expect(err).toHaveBeenCalledWith(
        "useSuggestionNotifier: show_suggestion_notification failed",
        expect.any(Error),
      ),
    );
    err.mockRestore();
  });

  it("is inert outside Tauri (runtimeEnabled=false)", () => {
    const { listen } = fakeListen();
    renderHook(() =>
      useSuggestionNotifier({ enabled: true, runtimeEnabled: false, listen }),
    );
    expect(listen).not.toHaveBeenCalled();
  });

  it("unsubscribes on unmount", async () => {
    const unlisten = vi.fn();
    const listen = vi.fn().mockResolvedValue(unlisten);
    const { unmount } = renderHook(() =>
      useSuggestionNotifier({
        enabled: true,
        runtimeEnabled: true,
        listen: listen as never,
      }),
    );
    await vi.waitFor(() => expect(listen).toHaveBeenCalled());
    unmount();
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalled());
  });

  it("unsubscribes immediately once listen() resolves after an early unmount", async () => {
    // The counterpart to the test above: there, listen() had already
    // resolved (unlisten was set) by the time unmount ran, so cleanup
    // called it directly. Here, unmount runs *before* listen() resolves,
    // so cleanup finds nothing to call yet (`unlisten` still null) — the
    // late resolution must instead see `cancelled` and call `un()` itself.
    let resolveListen!: (fn: () => void) => void;
    const listen = vi.fn(
      () =>
        new Promise<() => void>((resolve) => {
          resolveListen = resolve;
        }),
    );
    const unlistenSpy = vi.fn();
    const { unmount } = renderHook(() =>
      useSuggestionNotifier({
        enabled: true,
        runtimeEnabled: true,
        listen: listen as never,
      }),
    );
    unmount();
    resolveListen(unlistenSpy);
    await vi.waitFor(() => expect(unlistenSpy).toHaveBeenCalled());
  });
});
