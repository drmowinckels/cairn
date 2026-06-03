import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();
const openMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
  open: (...args: unknown[]) => openMock(...args),
  save: vi.fn(),
}));

type WithInternals = { __TAURI_INTERNALS__?: unknown };

const DEFAULT_SETTINGS = {
  enabled: false,
  dir: null as string | null,
  intervalHours: 24,
  keep: 14,
};
const CONFIGURED = {
  enabled: true,
  dir: "/sync/cairn",
  intervalHours: 24,
  keep: 14,
};

/**
 * Answer the two mount calls (`get_auto_backup_settings`,
 * `auto_backup_status`) and `set_pinned` (from the folder picker), then
 * delegate to per-test handlers. `set_auto_backup_settings` echoes the
 * settings it was given by default, mimicking the backend's normalize.
 */
function mockInvoke(
  handlers: Record<string, (...args: unknown[]) => unknown> = {},
  settings = DEFAULT_SETTINGS,
) {
  invokeMock.mockImplementation(async (cmd: string, ...rest: unknown[]) => {
    const handler = handlers[cmd];
    if (handler) return handler(...rest);
    if (cmd === "get_auto_backup_settings") return settings;
    if (cmd === "auto_backup_status") return { lastBackupAt: null, count: 0 };
    if (cmd === "set_auto_backup_settings") {
      return (rest[0] as { settings: unknown }).settings;
    }
    if (cmd === "set_pinned") return undefined;
    return undefined;
  });
}

afterEach(() => {
  invokeMock.mockReset();
  openMock.mockReset();
});

describe("useAutoBackup (outside Tauri)", () => {
  beforeEach(() => {
    delete (globalThis as WithInternals).__TAURI_INTERNALS__;
    vi.resetModules();
  });

  it("returns defaults, idle op, and makes no IPC calls", async () => {
    const { useAutoBackup } = await import("./use-auto-backup");
    const { result } = renderHook(() => useAutoBackup());
    expect(result.current.settings).toEqual(DEFAULT_SETTINGS);
    expect(result.current.op).toEqual({ kind: "idle" });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("chooseFolder and backupNow are no-ops outside Tauri", async () => {
    const { useAutoBackup } = await import("./use-auto-backup");
    const { result } = renderHook(() => useAutoBackup());
    await act(async () => {
      await result.current.chooseFolder();
      await result.current.backupNow();
    });
    expect(openMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.current.op).toEqual({ kind: "idle" });
  });
});

describe("useAutoBackup (inside Tauri)", () => {
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

  it("loads settings on mount", async () => {
    mockInvoke({}, CONFIGURED);
    const { useAutoBackup } = await import("./use-auto-backup");
    const { result } = renderHook(() => useAutoBackup());
    await waitFor(() => expect(result.current.settings).toEqual(CONFIGURED));
  });

  it("setEnabled refuses to turn on without a folder", async () => {
    mockInvoke({}, DEFAULT_SETTINGS);
    const { useAutoBackup } = await import("./use-auto-backup");
    const { result } = renderHook(() => useAutoBackup());
    await waitFor(() => expect(result.current.settings.dir).toBeNull());
    await act(async () => {
      await result.current.setEnabled(true);
    });
    expect(result.current.op).toEqual({
      kind: "error",
      message: "Choose a backup folder first.",
    });
    // No set call — the guard fired before persisting.
    expect(
      invokeMock.mock.calls.some((c) => c[0] === "set_auto_backup_settings"),
    ).toBe(false);
  });

  it("setEnabled(false) persists a pause when a folder is configured", async () => {
    const setCall = vi.fn(
      (arg: unknown) => (arg as { settings: unknown }).settings,
    );
    mockInvoke({ set_auto_backup_settings: setCall }, CONFIGURED);
    const { useAutoBackup } = await import("./use-auto-backup");
    const { result } = renderHook(() => useAutoBackup());
    await waitFor(() => expect(result.current.settings).toEqual(CONFIGURED));
    await act(async () => {
      await result.current.setEnabled(false);
    });
    expect(setCall).toHaveBeenCalledWith({
      settings: { ...CONFIGURED, enabled: false },
    });
    expect(result.current.op.kind).toBe("done");
  });

  it("chooseFolder picks a directory and saves it enabled", async () => {
    const setCall = vi.fn(
      (arg: unknown) => (arg as { settings: unknown }).settings,
    );
    mockInvoke({ set_auto_backup_settings: setCall }, DEFAULT_SETTINGS);
    openMock.mockResolvedValue("/sync/cairn-backups");
    const { useAutoBackup } = await import("./use-auto-backup");
    const { result } = renderHook(() => useAutoBackup());
    await waitFor(() => expect(result.current.settings.dir).toBeNull());
    await act(async () => {
      await result.current.chooseFolder();
    });
    expect(openMock).toHaveBeenCalled();
    expect(setCall).toHaveBeenCalledWith({
      settings: {
        ...DEFAULT_SETTINGS,
        dir: "/sync/cairn-backups",
        enabled: true,
      },
    });
    expect(result.current.settings.dir).toBe("/sync/cairn-backups");
  });

  it("chooseFolder is a no-op when the dialog is cancelled", async () => {
    const setCall = vi.fn();
    mockInvoke({ set_auto_backup_settings: setCall }, DEFAULT_SETTINGS);
    openMock.mockResolvedValue(null);
    const { useAutoBackup } = await import("./use-auto-backup");
    const { result } = renderHook(() => useAutoBackup());
    await act(async () => {
      await result.current.chooseFolder();
    });
    expect(setCall).not.toHaveBeenCalled();
  });

  it("setIntervalHours and setKeep persist their values", async () => {
    const setCall = vi.fn(
      (arg: unknown) => (arg as { settings: unknown }).settings,
    );
    mockInvoke({ set_auto_backup_settings: setCall }, CONFIGURED);
    const { useAutoBackup } = await import("./use-auto-backup");
    const { result } = renderHook(() => useAutoBackup());
    await waitFor(() => expect(result.current.settings).toEqual(CONFIGURED));
    await act(async () => {
      await result.current.setIntervalHours(168);
    });
    await act(async () => {
      await result.current.setKeep(30);
    });
    const sent = setCall.mock.calls.map(
      (c) =>
        (c[0] as { settings: { intervalHours: number; keep: number } })
          .settings,
    );
    // Each mutator builds on the latest settings, so the keep change also
    // carries the interval set just before it.
    expect(sent[0]).toEqual({ ...CONFIGURED, intervalHours: 168 });
    expect(sent[1]).toEqual({ ...CONFIGURED, intervalHours: 168, keep: 30 });
  });

  it("backupNow runs a snapshot and reports the path; surfaces errors", async () => {
    mockInvoke(
      { backup_now: () => "/sync/cairn/cairn-auto-x.sqlite" },
      CONFIGURED,
    );
    const { useAutoBackup } = await import("./use-auto-backup");
    const { result } = renderHook(() => useAutoBackup());
    await waitFor(() => expect(result.current.settings).toEqual(CONFIGURED));
    await act(async () => {
      await result.current.backupNow();
    });
    expect(result.current.op).toEqual({
      kind: "done",
      message: "Backup written to /sync/cairn/cairn-auto-x.sqlite",
    });

    // Error path.
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "backup_now") throw new Error("disk full");
      if (cmd === "auto_backup_status") return { lastBackupAt: null, count: 0 };
      return undefined;
    });
    await act(async () => {
      await result.current.backupNow();
    });
    expect(result.current.op.kind).toBe("error");
  });

  it("keeps defaults when loading settings fails on mount", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_auto_backup_settings") throw new Error("db locked");
      return undefined;
    });
    const { useAutoBackup } = await import("./use-auto-backup");
    const { result } = renderHook(() => useAutoBackup());
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(result.current.settings).toEqual(DEFAULT_SETTINGS);
  });

  it("ignores a failing status refresh on mount", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_auto_backup_settings") return CONFIGURED;
      if (cmd === "auto_backup_status") throw new Error("nope");
      return undefined;
    });
    const { useAutoBackup } = await import("./use-auto-backup");
    const { result } = renderHook(() => useAutoBackup());
    await waitFor(() => expect(result.current.settings).toEqual(CONFIGURED));
    expect(result.current.status).toEqual({ lastBackupAt: null, count: 0 });
  });

  it("coalesces nullish IPC results to safe defaults", async () => {
    // A stubbed bridge can resolve the commands to null; the hook must
    // keep a real settings/status object so pure consumers don't choke.
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_auto_backup_settings") return null;
      if (cmd === "auto_backup_status") return null;
      return undefined;
    });
    const { useAutoBackup } = await import("./use-auto-backup");
    const { result } = renderHook(() => useAutoBackup());
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(result.current.settings).toEqual(DEFAULT_SETTINGS);
    expect(result.current.status).toEqual({ lastBackupAt: null, count: 0 });
  });

  it("setEnabled(true) turns backups on when a folder is already set", async () => {
    const setCall = vi.fn(
      (arg: unknown) => (arg as { settings: unknown }).settings,
    );
    const PAUSED = { ...CONFIGURED, enabled: false };
    mockInvoke({ set_auto_backup_settings: setCall }, PAUSED);
    const { useAutoBackup } = await import("./use-auto-backup");
    const { result } = renderHook(() => useAutoBackup());
    await waitFor(() => expect(result.current.settings).toEqual(PAUSED));
    await act(async () => {
      await result.current.setEnabled(true);
    });
    expect(setCall).toHaveBeenCalledWith({
      settings: { ...PAUSED, enabled: true },
    });
    expect(result.current.op.kind).toBe("done");
  });

  it("surfaces an error when saving settings fails", async () => {
    mockInvoke(
      {
        set_auto_backup_settings: () => {
          throw new Error("disk full");
        },
      },
      CONFIGURED,
    );
    const { useAutoBackup } = await import("./use-auto-backup");
    const { result } = renderHook(() => useAutoBackup());
    await waitFor(() => expect(result.current.settings).toEqual(CONFIGURED));
    await act(async () => {
      await result.current.setIntervalHours(168);
    });
    expect(result.current.op.kind).toBe("error");
  });

  it("surfaces an error when the folder dialog throws", async () => {
    mockInvoke({}, DEFAULT_SETTINGS);
    openMock.mockRejectedValue(new Error("dialog failed"));
    const { useAutoBackup } = await import("./use-auto-backup");
    const { result } = renderHook(() => useAutoBackup());
    await act(async () => {
      await result.current.chooseFolder();
    });
    expect(result.current.op.kind).toBe("error");
  });
});
