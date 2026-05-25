import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { snapshotToLiveSignals, useSnapshot } from "./use-snapshot";
import type { SignalSnapshot } from "./ipc";

describe("snapshotToLiveSignals", () => {
  const empty: SignalSnapshot = {
    ideFolder: null,
    gitBranch: null,
    windowTitle: null,
    appName: null,
    browserDomain: null,
    calendar: [],
  };

  it("returns [] for a null snapshot (loading)", () => {
    expect(snapshotToLiveSignals(null)).toEqual([]);
  });

  it("returns [] when every signal field is null (no observations yet)", () => {
    expect(snapshotToLiveSignals(empty)).toEqual([]);
  });

  it("emits rows for each populated signal, in spec order", () => {
    const rows = snapshotToLiveSignals({
      ...empty,
      ideFolder: "~/code/cairn",
      gitBranch: "feat/x",
      windowTitle: "rules.tsx",
      browserDomain: "github.com",
      appName: "Zed",
    });
    expect(rows.map((r) => r.signal)).toEqual([
      "ide.folder",
      "git.branch",
      "window.title",
      "browser.domain",
    ]);
    expect(rows.every((r) => r.app === "Zed")).toBe(true);
    expect(rows[0].value).toBe("~/code/cairn");
  });

  it("drops a signal whose value is the empty string (collector gave up)", () => {
    const rows = snapshotToLiveSignals({
      ...empty,
      ideFolder: "",
      gitBranch: "main",
      appName: "Zed",
    });
    // ideFolder = "" → dropped; only git.branch surfaces.
    expect(rows.map((r) => r.signal)).toEqual(["git.branch"]);
  });

  it("falls back to empty app string when appName is null", () => {
    const rows = snapshotToLiveSignals({
      ...empty,
      gitBranch: "main",
    });
    expect(rows[0].app).toBe("");
  });
});

describe("useSnapshot hook", () => {
  type SnapshotListener = (e: { payload: SignalSnapshot }) => void;

  it("seeds with current_snapshot() on mount", async () => {
    const seed: SignalSnapshot = {
      ideFolder: "~/seed",
      gitBranch: null,
      windowTitle: null,
      appName: "Zed",
      browserDomain: null,
      calendar: [],
    };
    const listenFn = vi.fn(async () => () => {});
    const fetchCurrent = vi.fn(async () => seed);
    const { result } = renderHook(() =>
      useSnapshot({
        enabled: true,
        listen: listenFn as unknown as typeof import("@tauri-apps/api/event").listen,
        fetchCurrent: fetchCurrent as unknown as typeof import("./ipc").currentSnapshot,
      }),
    );
    await waitFor(() => expect(result.current?.ideFolder).toBe("~/seed"));
    expect(fetchCurrent).toHaveBeenCalledOnce();
  });

  it("updates when a signal:snapshot event fires", async () => {
    let handler: SnapshotListener | null = null;
    const listenFn = vi.fn(async (_event: string, cb: SnapshotListener) => {
      handler = cb;
      return () => {
        handler = null;
      };
    });
    const fetchCurrent = vi.fn(async () => null);
    const { result } = renderHook(() =>
      useSnapshot({
        enabled: true,
        listen: listenFn as unknown as typeof import("@tauri-apps/api/event").listen,
        fetchCurrent: fetchCurrent as unknown as typeof import("./ipc").currentSnapshot,
      }),
    );
    // Wait for the listener registration to finish before firing.
    await waitFor(() => expect(handler).not.toBeNull());
    const next: SignalSnapshot = {
      ideFolder: "~/code/x",
      gitBranch: "main",
      windowTitle: null,
      appName: "Zed",
      browserDomain: null,
      calendar: [],
    };
    act(() => {
      handler!({ payload: next });
    });
    await waitFor(() => expect(result.current?.gitBranch).toBe("main"));
  });

  it("does nothing when disabled (no listener, no fetch)", () => {
    const listenFn = vi.fn(async () => () => {});
    const fetchCurrent = vi.fn(async () => null);
    renderHook(() =>
      useSnapshot({
        enabled: false,
        listen: listenFn as unknown as typeof import("@tauri-apps/api/event").listen,
        fetchCurrent: fetchCurrent as unknown as typeof import("./ipc").currentSnapshot,
      }),
    );
    expect(listenFn).not.toHaveBeenCalled();
    expect(fetchCurrent).not.toHaveBeenCalled();
  });
});
