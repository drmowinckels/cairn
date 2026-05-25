import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const resolveIdleMock = vi.fn();

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

const SAMPLE_RESUME = {
  since: "2026-05-25T14:50:00Z",
  until: "2026-05-25T15:02:00Z",
  durationSeconds: 720,
};

beforeEach(() => {
  resolveIdleMock.mockReset();
  resolveIdleMock.mockResolvedValue(null);
});

describe("useIdlePrompt", () => {
  it("surfaces an incoming signal:idle-resume payload as `prompt`", async () => {
    const { listen, harness } = makeListenHarness();
    const { useIdlePrompt } = await import("./use-idle-prompt");

    const { result } = renderHook(() =>
      useIdlePrompt({
        runningEntryId: "e1",
        resolveIdle: resolveIdleMock as never,
        listen: listen as never,
        enabled: true,
      }),
    );

    await waitFor(() => expect(harness.handler).not.toBeNull());
    expect(result.current.prompt).toBeNull();

    act(() => harness.emit(SAMPLE_RESUME));

    expect(result.current.prompt).toEqual(SAMPLE_RESUME);
    expect(resolveIdleMock).not.toHaveBeenCalled();
  });

  it("keep() calls resolveIdle with choice='keep' and clears the prompt", async () => {
    const { listen, harness } = makeListenHarness();
    const { useIdlePrompt } = await import("./use-idle-prompt");

    const { result } = renderHook(() =>
      useIdlePrompt({
        runningEntryId: "e1",
        resolveIdle: resolveIdleMock as never,
        listen: listen as never,
        enabled: true,
      }),
    );

    await waitFor(() => expect(harness.handler).not.toBeNull());
    act(() => harness.emit(SAMPLE_RESUME));

    await act(async () => {
      await result.current.keep();
    });

    expect(resolveIdleMock).toHaveBeenCalledTimes(1);
    expect(resolveIdleMock).toHaveBeenCalledWith({
      entryId: "e1",
      since: SAMPLE_RESUME.since,
      until: SAMPLE_RESUME.until,
      choice: "keep",
    });
    expect(result.current.prompt).toBeNull();
  });

  it("discard() calls resolveIdle with choice='discard'", async () => {
    const { listen, harness } = makeListenHarness();
    const { useIdlePrompt } = await import("./use-idle-prompt");

    const { result } = renderHook(() =>
      useIdlePrompt({
        runningEntryId: "e1",
        resolveIdle: resolveIdleMock as never,
        listen: listen as never,
        enabled: true,
      }),
    );

    await waitFor(() => expect(harness.handler).not.toBeNull());
    act(() => harness.emit(SAMPLE_RESUME));

    await act(async () => {
      await result.current.discard();
    });

    expect(resolveIdleMock).toHaveBeenCalledWith({
      entryId: "e1",
      since: SAMPLE_RESUME.since,
      until: SAMPLE_RESUME.until,
      choice: "discard",
    });
  });

  it("moveToBreak() calls resolveIdle with choice='break'", async () => {
    const { listen, harness } = makeListenHarness();
    const { useIdlePrompt } = await import("./use-idle-prompt");

    const { result } = renderHook(() =>
      useIdlePrompt({
        runningEntryId: "e1",
        resolveIdle: resolveIdleMock as never,
        listen: listen as never,
        enabled: true,
      }),
    );

    await waitFor(() => expect(harness.handler).not.toBeNull());
    act(() => harness.emit(SAMPLE_RESUME));

    await act(async () => {
      await result.current.moveToBreak();
    });

    expect(resolveIdleMock).toHaveBeenCalledWith({
      entryId: "e1",
      since: SAMPLE_RESUME.since,
      until: SAMPLE_RESUME.until,
      choice: "break",
    });
  });

  it("drops the event when no timer is running (no entry to resolve against)", async () => {
    const { listen, harness } = makeListenHarness();
    const { useIdlePrompt } = await import("./use-idle-prompt");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() =>
      useIdlePrompt({
        runningEntryId: null,
        resolveIdle: resolveIdleMock as never,
        listen: listen as never,
        enabled: true,
      }),
    );

    await waitFor(() => expect(harness.handler).not.toBeNull());
    act(() => harness.emit(SAMPLE_RESUME));

    expect(result.current.prompt).toEqual(SAMPLE_RESUME);
    await act(async () => {
      await result.current.discard();
    });
    expect(resolveIdleMock).not.toHaveBeenCalled();
    expect(result.current.prompt).toBeNull();
    // The dropped choice is loud, not silent — the user expected
    // their click to take effect.
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("snapshots runningEntryId at event-arrival time (survives mid-modal stop)", async () => {
    // Race scenario: idle resume fires while entry "e1" is
    // running. Before the user clicks, they stop the timer
    // manually → runningEntryId becomes null. The hook must still
    // apply the user's choice to entry "e1" (the entry that WAS
    // running when the idle happened), not silently drop because
    // runningEntryId is now null.
    const { listen, harness } = makeListenHarness();
    const { useIdlePrompt } = await import("./use-idle-prompt");

    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) =>
        useIdlePrompt({
          runningEntryId: id,
          resolveIdle: resolveIdleMock as never,
          listen: listen as never,
          enabled: true,
        }),
      { initialProps: { id: "e1" as string | null } },
    );
    await waitFor(() => expect(harness.handler).not.toBeNull());

    // Event arrives while "e1" is running.
    act(() => harness.emit(SAMPLE_RESUME));
    expect(result.current.prompt).toEqual(SAMPLE_RESUME);

    // User stops the timer before clicking anything.
    rerender({ id: null });

    // User clicks Discard → resolve_idle MUST be called with
    // entryId="e1" (the snapshot), not skipped.
    await act(async () => {
      await result.current.discard();
    });
    expect(resolveIdleMock).toHaveBeenCalledWith({
      entryId: "e1",
      since: SAMPLE_RESUME.since,
      until: SAMPLE_RESUME.until,
      choice: "discard",
    });
  });

  it("does not subscribe when disabled (outside Tauri)", async () => {
    const { listen, harness } = makeListenHarness();
    const { useIdlePrompt } = await import("./use-idle-prompt");

    renderHook(() =>
      useIdlePrompt({
        runningEntryId: "e1",
        resolveIdle: resolveIdleMock as never,
        listen: listen as never,
        enabled: false,
      }),
    );

    expect(harness.handler).toBeNull();
  });

  it("unlistens on unmount", async () => {
    const { listen, harness } = makeListenHarness();
    const { useIdlePrompt } = await import("./use-idle-prompt");

    const { unmount } = renderHook(() =>
      useIdlePrompt({
        runningEntryId: "e1",
        resolveIdle: resolveIdleMock as never,
        listen: listen as never,
        enabled: true,
      }),
    );
    await waitFor(() => expect(harness.handler).not.toBeNull());
    unmount();
    expect(harness.unlisten).toHaveBeenCalledTimes(1);
  });
});
