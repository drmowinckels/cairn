import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

type WithInternals = { __TAURI_INTERNALS__?: unknown };

afterEach(() => {
  invokeMock.mockReset();
});

describe("useOnboarding (outside Tauri)", () => {
  beforeEach(() => {
    delete (globalThis as WithInternals).__TAURI_INTERNALS__;
    vi.resetModules();
  });

  it("resolves to 'completed' so the dev shell never traps in onboarding", async () => {
    const { useOnboarding } = await import("./use-onboarding");
    const { result } = renderHook(() => useOnboarding());
    await waitFor(() => expect(result.current.status).toBe("completed"));
    expect(result.current.state?.completedAt).toBeTruthy();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("reset returns null completedAt and flips status to needs-onboarding", async () => {
    const { useOnboarding } = await import("./use-onboarding");
    const { result } = renderHook(() => useOnboarding());
    await waitFor(() => expect(result.current.status).toBe("completed"));
    await act(async () => {
      await result.current.reset();
    });
    expect(result.current.state?.completedAt).toBeNull();
    expect(result.current.status).toBe("needs-onboarding");
  });
});

describe("useOnboarding (inside Tauri)", () => {
  let original: unknown;

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

  it("reads `get_onboarding_state` on mount and surfaces needs-onboarding for a NULL marker", async () => {
    invokeMock.mockResolvedValueOnce({ completedAt: null });
    const { useOnboarding } = await import("./use-onboarding");
    const { result } = renderHook(() => useOnboarding());
    await waitFor(() => expect(result.current.status).toBe("needs-onboarding"));
    expect(invokeMock).toHaveBeenCalledWith("get_onboarding_state");
    expect(result.current.state?.completedAt).toBeNull();
  });

  it("surfaces completed when the marker has a timestamp", async () => {
    invokeMock.mockResolvedValueOnce({ completedAt: "2026-01-01T00:00:00Z" });
    const { useOnboarding } = await import("./use-onboarding");
    const { result } = renderHook(() => useOnboarding());
    await waitFor(() => expect(result.current.status).toBe("completed"));
    expect(result.current.state?.completedAt).toBe("2026-01-01T00:00:00Z");
  });

  it("complete() calls `complete_onboarding` and flips to completed", async () => {
    invokeMock
      .mockResolvedValueOnce({ completedAt: null }) // initial get
      .mockResolvedValueOnce({ completedAt: "2026-05-26T12:00:00Z" }); // complete
    const { useOnboarding } = await import("./use-onboarding");
    const { result } = renderHook(() => useOnboarding());
    await waitFor(() => expect(result.current.status).toBe("needs-onboarding"));
    await act(async () => {
      await result.current.complete();
    });
    expect(invokeMock).toHaveBeenCalledWith("complete_onboarding");
    expect(result.current.status).toBe("completed");
    expect(result.current.state?.completedAt).toBe("2026-05-26T12:00:00Z");
  });

  it("reset() calls `reset_onboarding` and flips to needs-onboarding", async () => {
    invokeMock
      .mockResolvedValueOnce({ completedAt: "2026-01-01T00:00:00Z" }) // initial get
      .mockResolvedValueOnce({ completedAt: null }); // reset
    const { useOnboarding } = await import("./use-onboarding");
    const { result } = renderHook(() => useOnboarding());
    await waitFor(() => expect(result.current.status).toBe("completed"));
    await act(async () => {
      await result.current.reset();
    });
    expect(invokeMock).toHaveBeenCalledWith("reset_onboarding");
    expect(result.current.status).toBe("needs-onboarding");
    expect(result.current.state?.completedAt).toBeNull();
  });

  it("a failed read falls back to completed so a transient hiccup doesn't trap the user", async () => {
    invokeMock.mockRejectedValueOnce(new Error("DB locked"));
    const { useOnboarding } = await import("./use-onboarding");
    const { result } = renderHook(() => useOnboarding());
    await waitFor(() => expect(result.current.status).toBe("completed"));
    expect(result.current.state?.completedAt).toBeTruthy();
  });

  it("refresh() re-reads after a sibling action and updates status", async () => {
    invokeMock
      .mockResolvedValueOnce({ completedAt: null })
      .mockResolvedValueOnce({ completedAt: "2026-05-26T12:00:00Z" });
    const { useOnboarding } = await import("./use-onboarding");
    const { result } = renderHook(() => useOnboarding());
    await waitFor(() => expect(result.current.status).toBe("needs-onboarding"));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.status).toBe("completed");
  });
});
