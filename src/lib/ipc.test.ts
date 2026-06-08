import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

type WithInternals = { __TAURI_INTERNALS__?: unknown };

afterEach(() => {
  invokeMock.mockReset();
});

describe("ipc helpers (inside Tauri)", () => {
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

  it("updateEntry forwards the input under an `input` key", async () => {
    invokeMock.mockResolvedValue({ id: "e1" });
    const { updateEntry } = await import("./ipc");
    const input = { id: "e1", description: "x" };
    const result = await updateEntry(input);
    expect(invokeMock).toHaveBeenCalledWith("update_entry", { input });
    expect(result).toEqual({ id: "e1" });
  });

  it("createEntry forwards the input under an `input` key", async () => {
    invokeMock.mockResolvedValue({ id: "e2" });
    const { createEntry } = await import("./ipc");
    const input = {
      startedAt: "2026-05-26T09:00:00Z",
      endedAt: "2026-05-26T10:00:00Z",
      description: "manual",
      source: "manual",
    };
    const result = await createEntry(input);
    expect(invokeMock).toHaveBeenCalledWith("create_entry", { input });
    expect(result).toEqual({ id: "e2" });
  });

  it("idleSeconds invokes the command and returns the count", async () => {
    invokeMock.mockResolvedValue(420);
    const { idleSeconds } = await import("./ipc");
    expect(await idleSeconds()).toBe(420);
    expect(invokeMock).toHaveBeenCalledWith("idle_seconds");
  });

  it("deleteEntry forwards the id and ignores the response", async () => {
    invokeMock.mockResolvedValue(null);
    const { deleteEntry } = await import("./ipc");
    await deleteEntry("entry-7");
    expect(invokeMock).toHaveBeenCalledWith("delete_entry", { id: "entry-7" });
  });

  it("upcomingCalendarEvents passes the default limit when none is given", async () => {
    invokeMock.mockResolvedValue([]);
    const { upcomingCalendarEvents } = await import("./ipc");
    const events = await upcomingCalendarEvents();
    expect(invokeMock).toHaveBeenCalledWith("upcoming_calendar_events", {
      limit: 3,
    });
    expect(events).toEqual([]);
  });

  it("upcomingCalendarEvents forwards an explicit limit", async () => {
    invokeMock.mockResolvedValue([{ uid: "u1" }]);
    const { upcomingCalendarEvents } = await import("./ipc");
    const events = await upcomingCalendarEvents(7);
    expect(invokeMock).toHaveBeenCalledWith("upcoming_calendar_events", {
      limit: 7,
    });
    expect(events).toEqual([{ uid: "u1" }]);
  });

  it("startSignalCapture returns the absolute file path from the backend", async () => {
    invokeMock.mockResolvedValue("/tmp/cairn/debug-signals.ndjson");
    const { startSignalCapture } = await import("./ipc");
    const path = await startSignalCapture();
    expect(invokeMock).toHaveBeenCalledWith("start_signal_capture");
    expect(path).toBe("/tmp/cairn/debug-signals.ndjson");
  });

  it("stopSignalCapture invokes the command and ignores the response", async () => {
    invokeMock.mockResolvedValue(null);
    const { stopSignalCapture } = await import("./ipc");
    await stopSignalCapture();
    expect(invokeMock).toHaveBeenCalledWith("stop_signal_capture");
  });

  it("signalCaptureStatus passes the backend payload through", async () => {
    invokeMock.mockResolvedValue({
      active: true,
      path: "/tmp/cairn/debug-signals.ndjson",
      bytesWritten: 123,
    });
    const { signalCaptureStatus } = await import("./ipc");
    const status = await signalCaptureStatus();
    expect(invokeMock).toHaveBeenCalledWith("signal_capture_status");
    expect(status).toEqual({
      active: true,
      path: "/tmp/cairn/debug-signals.ndjson",
      bytesWritten: 123,
    });
  });

  it("getGitDiscoveryRoots returns the backend list", async () => {
    invokeMock.mockResolvedValue(["~/code", "~/work"]);
    const { getGitDiscoveryRoots } = await import("./ipc");
    const roots = await getGitDiscoveryRoots();
    expect(invokeMock).toHaveBeenCalledWith("get_git_discovery_roots");
    expect(roots).toEqual(["~/code", "~/work"]);
  });

  it("setGitDiscoveryRoots forwards roots and returns the updated status", async () => {
    invokeMock.mockResolvedValue({
      discoveryRoots: ["~/code"],
      watchedCount: 3,
    });
    const { setGitDiscoveryRoots } = await import("./ipc");
    const status = await setGitDiscoveryRoots(["~/code"]);
    expect(invokeMock).toHaveBeenCalledWith("set_git_discovery_roots", {
      roots: ["~/code"],
    });
    expect(status).toEqual({ discoveryRoots: ["~/code"], watchedCount: 3 });
  });

  it("setPopoverSize forwards width/height", async () => {
    invokeMock.mockResolvedValue(null);
    const { setPopoverSize } = await import("./ipc");
    await setPopoverSize(680, 900);
    expect(invokeMock).toHaveBeenCalledWith("set_popover_size", {
      width: 680,
      height: 900,
    });
  });

  it("checkForUpdate invokes the command and returns the update info", async () => {
    const info = {
      version: "0.2.0",
      currentVersion: "0.1.0",
      notes: null,
      releaseUrl: "https://github.com/drmowinckels/cairn/releases/tag/v0.2.0",
    };
    invokeMock.mockResolvedValue(info);
    const { checkForUpdate } = await import("./ipc");
    expect(await checkForUpdate()).toEqual(info);
    expect(invokeMock).toHaveBeenCalledWith("check_for_update");
  });

  it("listPlugins invokes the command and returns the list", async () => {
    const list = [
      {
        id: "calendar",
        name: "Calendar",
        capabilities: ["network"],
        enabled: true,
      },
    ];
    invokeMock.mockResolvedValue(list);
    const { listPlugins } = await import("./ipc");
    expect(await listPlugins()).toEqual(list);
    expect(invokeMock).toHaveBeenCalledWith("list_plugins");
  });

  it("setPluginEnabled forwards id + enabled and returns the updated list", async () => {
    invokeMock.mockResolvedValue([]);
    const { setPluginEnabled } = await import("./ipc");
    await setPluginEnabled("calendar", false);
    expect(invokeMock).toHaveBeenCalledWith("set_plugin_enabled", {
      id: "calendar",
      enabled: false,
    });
  });

  it("plugin commands coerce an undefined backend response to []", async () => {
    // A stubbed invoke (e.g. the a11y audit harness) resolves undefined
    // for un-mocked commands; the UI must never receive a non-array.
    invokeMock.mockResolvedValue(undefined);
    const { listPlugins, setPluginEnabled } = await import("./ipc");
    expect(await listPlugins()).toEqual([]);
    expect(await setPluginEnabled("calendar", true)).toEqual([]);
  });

  it("listConnectors invokes the command and returns the list", async () => {
    const list = [
      {
        id: "sample-tasks",
        name: "Sample tasks",
        capabilities: [],
        kind: { file: { format: "todotxt", path: "~/TODO.txt" } },
      },
    ];
    invokeMock.mockResolvedValue(list);
    const { listConnectors } = await import("./ipc");
    expect(await listConnectors()).toEqual(list);
    expect(invokeMock).toHaveBeenCalledWith("list_connectors");
  });

  it("listConnectorProjects / listConnectorTasks forward their ids", async () => {
    invokeMock.mockResolvedValue([]);
    const { listConnectorProjects, listConnectorTasks } = await import("./ipc");
    await listConnectorProjects("sample-tasks");
    expect(invokeMock).toHaveBeenCalledWith("list_connector_projects", {
      connectorId: "sample-tasks",
    });
    await listConnectorTasks("sample-tasks", "cairn");
    expect(invokeMock).toHaveBeenCalledWith("list_connector_tasks", {
      connectorId: "sample-tasks",
      projectId: "cairn",
    });
  });

  it("setConnectorSecret / clearConnectorSecret forward their args", async () => {
    invokeMock.mockResolvedValue([]);
    const { setConnectorSecret, clearConnectorSecret } = await import("./ipc");
    await setConnectorSecret("remote", "ghp_x");
    expect(invokeMock).toHaveBeenCalledWith("set_connector_secret", {
      connectorId: "remote",
      token: "ghp_x",
    });
    await clearConnectorSecret("remote");
    expect(invokeMock).toHaveBeenCalledWith("clear_connector_secret", {
      connectorId: "remote",
    });
  });

  it("setConnectorEnabled forwards its args and coerces undefined to []", async () => {
    invokeMock.mockResolvedValue(undefined);
    const { setConnectorEnabled } = await import("./ipc");
    expect(await setConnectorEnabled("remote", false)).toEqual([]);
    expect(invokeMock).toHaveBeenCalledWith("set_connector_enabled", {
      connectorId: "remote",
      enabled: false,
    });
  });

  it("connector commands coerce an undefined backend response to a safe default", async () => {
    invokeMock.mockResolvedValue(undefined);
    const {
      listConnectors,
      listConnectorProjects,
      listConnectorTasks,
      setConnectorSecret,
      clearConnectorSecret,
    } = await import("./ipc");
    const emptyList = { items: [], stale: false, fetchedAt: null };
    expect(await listConnectors()).toEqual([]);
    expect(await listConnectorProjects("x")).toEqual(emptyList);
    expect(await listConnectorTasks("x", "y")).toEqual(emptyList);
    expect(await setConnectorSecret("x", "t")).toEqual([]);
    expect(await clearConnectorSecret("x")).toEqual([]);
  });
});

describe("ipc helpers (outside Tauri)", () => {
  beforeEach(() => {
    delete (globalThis as WithInternals).__TAURI_INTERNALS__;
    vi.resetModules();
  });

  it("upcomingCalendarEvents short-circuits to [] without calling the backend", async () => {
    const { upcomingCalendarEvents } = await import("./ipc");
    const events = await upcomingCalendarEvents(5);
    expect(events).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("signalCaptureStatus short-circuits to inactive without calling the backend", async () => {
    const { signalCaptureStatus } = await import("./ipc");
    const status = await signalCaptureStatus();
    expect(status).toEqual({ active: false, path: null, bytesWritten: 0 });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("getGitDiscoveryRoots returns the dev default without the backend", async () => {
    const { getGitDiscoveryRoots } = await import("./ipc");
    expect(await getGitDiscoveryRoots()).toEqual(["~/code"]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("setGitDiscoveryRoots echoes a synthetic status without the backend", async () => {
    const { setGitDiscoveryRoots } = await import("./ipc");
    const status = await setGitDiscoveryRoots(["~/x"]);
    expect(status).toEqual({ discoveryRoots: ["~/x"], watchedCount: 0 });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("setPopoverSize short-circuits without the backend", async () => {
    const { setPopoverSize } = await import("./ipc");
    await setPopoverSize(560, 760);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("connector secret commands short-circuit to [] without the backend", async () => {
    const { setConnectorSecret, clearConnectorSecret, setConnectorEnabled } =
      await import("./ipc");
    expect(await setConnectorSecret("x", "t")).toEqual([]);
    expect(await clearConnectorSecret("x")).toEqual([]);
    expect(await setConnectorEnabled("x", false)).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("idleSeconds short-circuits to null without the backend", async () => {
    const { idleSeconds } = await import("./ipc");
    expect(await idleSeconds()).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("checkForUpdate short-circuits to null without the backend", async () => {
    const { checkForUpdate } = await import("./ipc");
    expect(await checkForUpdate()).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("getAutoBackupSettings returns defaults without the backend", async () => {
    const { getAutoBackupSettings, AUTO_BACKUP_DEFAULTS } =
      await import("./ipc");
    expect(await getAutoBackupSettings()).toEqual(AUTO_BACKUP_DEFAULTS);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("setAutoBackupSettings echoes its input without the backend", async () => {
    const { setAutoBackupSettings } = await import("./ipc");
    const settings = {
      enabled: true,
      dir: "/sync/cairn",
      intervalHours: 12,
      keep: 7,
    };
    expect(await setAutoBackupSettings(settings)).toEqual(settings);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("autoBackupStatus returns an empty status without the backend", async () => {
    const { autoBackupStatus } = await import("./ipc");
    expect(await autoBackupStatus()).toEqual({ lastBackupAt: null, count: 0 });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("listPlugins resolves to [] without the backend", async () => {
    const { listPlugins } = await import("./ipc");
    expect(await listPlugins()).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("setPluginEnabled resolves to [] without the backend", async () => {
    const { setPluginEnabled } = await import("./ipc");
    expect(await setPluginEnabled("calendar", false)).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("connector commands resolve to safe defaults without the backend", async () => {
    const { listConnectors, listConnectorProjects, listConnectorTasks } =
      await import("./ipc");
    const emptyList = { items: [], stale: false, fetchedAt: null };
    expect(await listConnectors()).toEqual([]);
    expect(await listConnectorProjects("x")).toEqual(emptyList);
    expect(await listConnectorTasks("x", "y")).toEqual(emptyList);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
