import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useNotificationWindow } from "./use-notification-window";
import type { Project, RuleMatchEvent } from "./types";

const SUGGESTION: RuleMatchEvent = {
  ruleId: "r1",
  ruleName: "Cairn dev",
  confidence: "suggestive",
  ambiguityBehavior: "prompt",
  project: "p1",
  tags: ["dev"],
  description: "Writing tests",
};

const PROJECT: Project = {
  id: "p1",
  name: "Aurora",
  clientId: null,
  color: "#000",
  archived: false,
  estimateHours: null,
};

function noopListen() {
  return vi.fn(async () => () => {}) as never;
}

afterEach(() => vi.clearAllMocks());

// Every test below builds its `opts` once, outside the `renderHook`
// callback, and reuses that same object — a fresh `vi.fn()` created inside
// the callback would get a new identity on every re-render (each state
// update re-invokes the callback), which re-fires the hook's
// mount/suggestion effects and can stomp a state change we just made (or,
// worse, loop: a fresh array/object resolved value is a genuine reference
// change, so `setState` keeps firing). Mirrors `useIdleWindow`'s test
// convention.

describe("useNotificationWindow", () => {
  it("uses its default opts (enabled/listen/pendingNotification) when none are provided", () => {
    // Outside Tauri (the vitest env), `enabled` defaults to `inTauri`
    // (false), so the hook's effects no-op — this only pins that calling
    // it with no opts at all doesn't throw and falls back sanely.
    const { result } = renderHook(() => useNotificationWindow());
    expect(result.current.suggestion).toBeNull();
    expect(result.current.projectsById).toEqual({});
  });

  it("seeds the suggestion from pending_notification on mount", async () => {
    const opts = {
      enabled: true,
      listen: noopListen(),
      pendingNotification: vi.fn().mockResolvedValue(SUGGESTION) as never,
    };
    const { result } = renderHook(() => useNotificationWindow(opts));
    await waitFor(() => expect(result.current.suggestion).toEqual(SUGGESTION));
  });

  it("resolves projectsById once a suggestion arrives", async () => {
    const opts = {
      enabled: true,
      listen: noopListen(),
      pendingNotification: vi.fn().mockResolvedValue(SUGGESTION) as never,
      listProjects: vi.fn().mockResolvedValue([PROJECT]) as never,
    };
    const { result } = renderHook(() => useNotificationWindow(opts));
    await waitFor(() =>
      expect(result.current.projectsById).toEqual({ p1: PROJECT }),
    );
  });

  it("logs and leaves projectsById empty if the lookup rejects", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const opts = {
      enabled: true,
      listen: noopListen(),
      pendingNotification: vi.fn().mockResolvedValue(SUGGESTION) as never,
      listProjects: vi.fn().mockRejectedValue(new Error("boom")) as never,
    };
    renderHook(() => useNotificationWindow(opts));
    await waitFor(() =>
      expect(err).toHaveBeenCalledWith(
        "notification: list_projects failed",
        expect.any(Error),
      ),
    );
    err.mockRestore();
  });

  it("ignores a late listen() resolution after an immediate unmount", async () => {
    // Counterpart to the other listen()-related tests, which all unmount
    // (or never unmount) after listen() has already resolved. Here,
    // unmount runs first, so the effect cleanup finds `unlisten` still
    // null; the late resolution must instead see `cancelled` and call
    // `un()` itself rather than stashing it.
    let resolveListen!: (fn: () => void) => void;
    const listen = vi.fn(
      () =>
        new Promise<() => void>((resolve) => {
          resolveListen = resolve;
        }),
    );
    const unlistenSpy = vi.fn();
    const opts = {
      enabled: true,
      listen: listen as never,
      pendingNotification: vi.fn().mockResolvedValue(null) as never,
    };
    const { unmount } = renderHook(() => useNotificationWindow(opts));
    unmount();
    resolveListen(unlistenSpy);
    await vi.waitFor(() => expect(unlistenSpy).toHaveBeenCalled());
  });

  it("ignores a late list_projects resolution after an immediate unmount", async () => {
    // Same "cancelled" guard as above, for the projects-lookup effect:
    // unmounting before list_projects resolves must not call setState on
    // the unmounted hook.
    let resolveProjects!: (list: Project[]) => void;
    const listProjects = vi.fn(
      () =>
        new Promise<Project[]>((resolve) => {
          resolveProjects = resolve;
        }),
    );
    const opts = {
      enabled: true,
      listen: noopListen(),
      pendingNotification: vi.fn().mockResolvedValue(SUGGESTION) as never,
      listProjects: listProjects as never,
    };
    const { result, unmount } = renderHook(() => useNotificationWindow(opts));
    await waitFor(() => expect(result.current.suggestion).toEqual(SUGGESTION));
    await vi.waitFor(() => expect(listProjects).toHaveBeenCalled());
    unmount();
    resolveProjects([PROJECT]);
    // Nothing to assert on `result.current` post-unmount — the point is
    // that resolving after unmount doesn't throw or warn about setting
    // state on an unmounted component.
    await new Promise((r) => setTimeout(r, 0));
  });

  it("updates the suggestion from a live signal:match event", async () => {
    let emit: ((e: { payload: RuleMatchEvent }) => void) | undefined;
    const listen = vi.fn(
      async (_name: string, cb: (e: { payload: RuleMatchEvent }) => void) => {
        emit = cb;
        return () => {};
      },
    );
    const opts = {
      enabled: true,
      listen: listen as never,
      pendingNotification: vi.fn().mockResolvedValue(null) as never,
    };
    const { result } = renderHook(() => useNotificationWindow(opts));
    await waitFor(() => expect(emit).toBeTypeOf("function"));
    act(() => emit!({ payload: SUGGESTION }));
    expect(result.current.suggestion).toEqual(SUGGESTION);
  });

  it("confirm() starts the entry with the suggested project and dismisses", async () => {
    const startEntry = vi.fn().mockResolvedValue({});
    const dismissSuggestionNotification = vi.fn().mockResolvedValue(undefined);
    const opts = {
      enabled: true,
      listen: noopListen(),
      pendingNotification: vi.fn().mockResolvedValue(SUGGESTION) as never,
      startEntry: startEntry as never,
      dismissSuggestionNotification: dismissSuggestionNotification as never,
    };
    const { result } = renderHook(() => useNotificationWindow(opts));
    await waitFor(() => expect(result.current.suggestion).toEqual(SUGGESTION));

    await act(async () => {
      await result.current.confirm();
    });

    expect(startEntry).toHaveBeenCalledWith({
      projectId: "p1",
      source: "rule",
      ruleId: "r1",
      description: "Writing tests",
    });
    expect(dismissSuggestionNotification).toHaveBeenCalled();
    expect(result.current.suggestion).toBeNull();
  });

  it("confirm() falls back to a null project and undefined description", async () => {
    const startEntry = vi.fn().mockResolvedValue({});
    const noProjectSuggestion: RuleMatchEvent = {
      ...SUGGESTION,
      project: null,
      description: "",
    };
    const opts = {
      enabled: true,
      listen: noopListen(),
      pendingNotification: vi
        .fn()
        .mockResolvedValue(noProjectSuggestion) as never,
      startEntry: startEntry as never,
      dismissSuggestionNotification: vi
        .fn()
        .mockResolvedValue(undefined) as never,
    };
    const { result } = renderHook(() => useNotificationWindow(opts));
    await waitFor(() =>
      expect(result.current.suggestion).toEqual(noProjectSuggestion),
    );

    await act(async () => {
      await result.current.confirm();
    });

    expect(startEntry).toHaveBeenCalledWith({
      projectId: null,
      source: "rule",
      ruleId: "r1",
      description: undefined,
    });
  });

  it("confirm() is a no-op when there is no suggestion", async () => {
    const startEntry = vi.fn();
    const opts = {
      enabled: true,
      listen: noopListen(),
      pendingNotification: vi.fn().mockResolvedValue(null) as never,
      startEntry: startEntry as never,
    };
    const { result } = renderHook(() => useNotificationWindow(opts));
    await act(async () => {
      await result.current.confirm();
    });
    expect(startEntry).not.toHaveBeenCalled();
  });

  it("logs and recovers when confirm's start_entry rejects", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const dismissSuggestionNotification = vi.fn().mockResolvedValue(undefined);
    const opts = {
      enabled: true,
      listen: noopListen(),
      pendingNotification: vi.fn().mockResolvedValue(SUGGESTION) as never,
      startEntry: vi.fn().mockRejectedValue(new Error("boom")) as never,
      dismissSuggestionNotification: dismissSuggestionNotification as never,
    };
    const { result } = renderHook(() => useNotificationWindow(opts));
    await waitFor(() => expect(result.current.suggestion).toEqual(SUGGESTION));
    await act(async () => {
      await result.current.confirm();
    });
    expect(err).toHaveBeenCalledWith(
      "useNotificationWindow: confirm start_entry failed",
      expect.any(Error),
    );
    expect(dismissSuggestionNotification).toHaveBeenCalled();
    err.mockRestore();
  });

  it("confirm() logs but does not throw when dismiss_suggestion_notification fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const opts = {
      enabled: true,
      listen: noopListen(),
      pendingNotification: vi.fn().mockResolvedValue(SUGGESTION) as never,
      startEntry: vi.fn().mockResolvedValue({}) as never,
      dismissSuggestionNotification: vi
        .fn()
        .mockRejectedValue(new Error("nope")) as never,
    };
    const { result } = renderHook(() => useNotificationWindow(opts));
    await waitFor(() => expect(result.current.suggestion).toEqual(SUGGESTION));
    await act(async () => {
      await result.current.confirm();
    });
    expect(err).toHaveBeenCalledWith(
      "dismiss_suggestion_notification failed",
      expect.any(Error),
    );
    err.mockRestore();
  });

  it("dismiss() snoozes the rule and hides the window", async () => {
    const snoozeRule = vi.fn().mockResolvedValue(undefined);
    const dismissSuggestionNotification = vi.fn().mockResolvedValue(undefined);
    const opts = {
      enabled: true,
      listen: noopListen(),
      pendingNotification: vi.fn().mockResolvedValue(SUGGESTION) as never,
      snoozeRule: snoozeRule as never,
      dismissSuggestionNotification: dismissSuggestionNotification as never,
    };
    const { result } = renderHook(() => useNotificationWindow(opts));
    await waitFor(() => expect(result.current.suggestion).toEqual(SUGGESTION));

    await act(async () => {
      await result.current.dismiss();
    });

    expect(snoozeRule).toHaveBeenCalledWith("r1", 300);
    expect(dismissSuggestionNotification).toHaveBeenCalled();
    expect(result.current.suggestion).toBeNull();
  });

  it("dismiss() still calls dismiss_suggestion_notification with nothing pending", async () => {
    const snoozeRule = vi.fn();
    const dismissSuggestionNotification = vi.fn().mockResolvedValue(undefined);
    const opts = {
      enabled: true,
      listen: noopListen(),
      pendingNotification: vi.fn().mockResolvedValue(null) as never,
      snoozeRule: snoozeRule as never,
      dismissSuggestionNotification: dismissSuggestionNotification as never,
    };
    const { result } = renderHook(() => useNotificationWindow(opts));

    await act(async () => {
      await result.current.dismiss();
    });

    expect(snoozeRule).not.toHaveBeenCalled();
    expect(dismissSuggestionNotification).toHaveBeenCalled();
  });

  it("logs but does not throw if snooze_rule fails on dismiss", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const opts = {
      enabled: true,
      listen: noopListen(),
      pendingNotification: vi.fn().mockResolvedValue(SUGGESTION) as never,
      snoozeRule: vi.fn().mockRejectedValue(new Error("nope")) as never,
      dismissSuggestionNotification: vi
        .fn()
        .mockResolvedValue(undefined) as never,
    };
    const { result } = renderHook(() => useNotificationWindow(opts));
    await waitFor(() => expect(result.current.suggestion).toEqual(SUGGESTION));
    await act(async () => {
      await result.current.dismiss();
    });
    expect(err).toHaveBeenCalledWith(
      "useNotificationWindow: snooze_rule failed",
      expect.any(Error),
    );
    err.mockRestore();
  });

  it("logs but does not throw if dismiss_suggestion_notification fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const opts = {
      enabled: true,
      listen: noopListen(),
      pendingNotification: vi.fn().mockResolvedValue(SUGGESTION) as never,
      snoozeRule: vi.fn().mockResolvedValue(undefined) as never,
      dismissSuggestionNotification: vi
        .fn()
        .mockRejectedValue(new Error("nope")) as never,
    };
    const { result } = renderHook(() => useNotificationWindow(opts));
    await waitFor(() => expect(result.current.suggestion).toEqual(SUGGESTION));
    await act(async () => {
      await result.current.dismiss();
    });
    expect(err).toHaveBeenCalledWith(
      "dismiss_suggestion_notification failed",
      expect.any(Error),
    );
    err.mockRestore();
  });

  it("acks paint to the backend once a suggestion is shown (#267)", async () => {
    const notificationWindowPainted = vi.fn().mockResolvedValue(undefined);
    const opts = {
      enabled: true,
      listen: noopListen(),
      pendingNotification: vi.fn().mockResolvedValue(SUGGESTION) as never,
      notificationWindowPainted: notificationWindowPainted as never,
    };
    renderHook(() => useNotificationWindow(opts));
    await waitFor(() => expect(notificationWindowPainted).toHaveBeenCalled());
  });

  it("does not ack paint while disabled", async () => {
    const notificationWindowPainted = vi.fn();
    const opts = {
      enabled: false,
      listen: noopListen(),
      pendingNotification: vi.fn().mockResolvedValue(SUGGESTION) as never,
      notificationWindowPainted: notificationWindowPainted as never,
    };
    renderHook(() => useNotificationWindow(opts));
    await new Promise((r) => setTimeout(r, 0));
    expect(notificationWindowPainted).not.toHaveBeenCalled();
  });

  it("logs but does not throw if the paint ack fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const notificationWindowPainted = vi
      .fn()
      .mockRejectedValue(new Error("nope"));
    const opts = {
      enabled: true,
      listen: noopListen(),
      pendingNotification: vi.fn().mockResolvedValue(SUGGESTION) as never,
      notificationWindowPainted: notificationWindowPainted as never,
    };
    renderHook(() => useNotificationWindow(opts));
    await waitFor(() =>
      expect(err).toHaveBeenCalledWith(
        "notification_window_painted failed",
        expect.any(Error),
      ),
    );
    err.mockRestore();
  });

  it("is inert when disabled (outside Tauri)", () => {
    const pending = vi.fn();
    const opts = {
      enabled: false,
      listen: noopListen(),
      pendingNotification: pending as never,
    };
    renderHook(() => useNotificationWindow(opts));
    expect(pending).not.toHaveBeenCalled();
  });

  it("logs pending_notification failures", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const opts = {
      enabled: true,
      listen: noopListen(),
      pendingNotification: vi
        .fn()
        .mockRejectedValue(new Error("boom")) as never,
    };
    renderHook(() => useNotificationWindow(opts));
    await waitFor(() =>
      expect(err).toHaveBeenCalledWith(
        "pending_notification failed",
        expect.any(Error),
      ),
    );
    err.mockRestore();
  });
});
