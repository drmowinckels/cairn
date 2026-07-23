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

  it("idleWindowPainted invokes the paint-ack command", async () => {
    invokeMock.mockResolvedValue(undefined);
    const { idleWindowPainted } = await import("./ipc");
    await idleWindowPainted();
    expect(invokeMock).toHaveBeenCalledWith("idle_window_painted");
  });

  it("showSuggestionNotification forwards the payload (#267)", async () => {
    invokeMock.mockResolvedValue(undefined);
    const { showSuggestionNotification } = await import("./ipc");
    const payload = {
      ruleId: "r1",
      ruleName: "Cairn dev",
      confidence: "suggestive" as const,
      ambiguityBehavior: "prompt" as const,
      project: "cairn",
      tags: [],
      description: "",
    };
    await showSuggestionNotification(payload);
    expect(invokeMock).toHaveBeenCalledWith("show_suggestion_notification", {
      payload,
    });
  });

  it("pendingNotification invokes the cold-start-stash command (#267)", async () => {
    invokeMock.mockResolvedValue(null);
    const { pendingNotification } = await import("./ipc");
    expect(await pendingNotification()).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("pending_notification");
  });

  it("dismissSuggestionNotification invokes the dismiss command (#267)", async () => {
    invokeMock.mockResolvedValue(undefined);
    const { dismissSuggestionNotification } = await import("./ipc");
    await dismissSuggestionNotification();
    expect(invokeMock).toHaveBeenCalledWith("dismiss_suggestion_notification");
  });

  it("notificationWindowPainted invokes the paint-ack command (#267)", async () => {
    invokeMock.mockResolvedValue(undefined);
    const { notificationWindowPainted } = await import("./ipc");
    await notificationWindowPainted();
    expect(invokeMock).toHaveBeenCalledWith("notification_window_painted");
  });

  it("autostartEnabled invokes the probe command", async () => {
    invokeMock.mockResolvedValue(true);
    const { autostartEnabled } = await import("./ipc");
    expect(await autostartEnabled()).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("autostart_enabled");
  });

  it("setAutostart forwards the enable flag and returns the resulting state", async () => {
    invokeMock.mockResolvedValue(true);
    const { setAutostart } = await import("./ipc");
    expect(await setAutostart(true)).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("set_autostart", { enable: true });
  });

  it("systemLocale invokes the command and returns the OS locale", async () => {
    invokeMock.mockResolvedValue("nb-NO");
    const { systemLocale } = await import("./ipc");
    expect(await systemLocale()).toBe("nb-NO");
    expect(invokeMock).toHaveBeenCalledWith("system_locale");
  });

  it("listAppCategories invokes the command and returns the table", async () => {
    const table = [
      { category: "meeting", label: "Meeting apps", apps: ["Zoom"] },
    ];
    invokeMock.mockResolvedValue(table);
    const { listAppCategories } = await import("./ipc");
    expect(await listAppCategories()).toEqual(table);
    expect(invokeMock).toHaveBeenCalledWith("list_app_categories");
  });

  it("getActivityLogSettings returns the backend settings", async () => {
    invokeMock.mockResolvedValue({ enabled: true, retentionDays: 30 });
    const { getActivityLogSettings } = await import("./ipc");
    expect(await getActivityLogSettings()).toEqual({
      enabled: true,
      retentionDays: 30,
    });
    expect(invokeMock).toHaveBeenCalledWith("get_activity_log_settings");
  });

  it("getActivityLogSettings coerces a null response to defaults", async () => {
    invokeMock.mockResolvedValue(null);
    const { getActivityLogSettings, ACTIVITY_LOG_DEFAULTS } =
      await import("./ipc");
    expect(await getActivityLogSettings()).toEqual(ACTIVITY_LOG_DEFAULTS);
  });

  it("setActivityLogSettings forwards the settings under a `settings` key", async () => {
    invokeMock.mockResolvedValue(null);
    const { setActivityLogSettings } = await import("./ipc");
    await setActivityLogSettings({ enabled: true, retentionDays: 7 });
    expect(invokeMock).toHaveBeenCalledWith("set_activity_log_settings", {
      settings: { enabled: true, retentionDays: 7 },
    });
  });

  it("deleteActivityLog invokes the command", async () => {
    invokeMock.mockResolvedValue(null);
    const { deleteActivityLog } = await import("./ipc");
    await deleteActivityLog();
    expect(invokeMock).toHaveBeenCalledWith("delete_activity_log");
  });

  it("listActivityLog forwards the date and returns the rows", async () => {
    const rows = [{ id: 1, appName: "Zoom" }];
    invokeMock.mockResolvedValue(rows);
    const { listActivityLog } = await import("./ipc");
    expect(await listActivityLog("2026-06-16")).toEqual(rows);
    expect(invokeMock).toHaveBeenCalledWith("list_activity_log", {
      date: "2026-06-16",
    });
  });

  it("listActivityLog coerces a null response to []", async () => {
    invokeMock.mockResolvedValue(null);
    const { listActivityLog } = await import("./ipc");
    expect(await listActivityLog("2026-06-16")).toEqual([]);
  });

  it("countUncategorizedActivity forwards the date and returns the count", async () => {
    invokeMock.mockResolvedValue(3);
    const { countUncategorizedActivity } = await import("./ipc");
    expect(await countUncategorizedActivity("2026-06-16")).toBe(3);
    expect(invokeMock).toHaveBeenCalledWith("count_uncategorized_activity", {
      date: "2026-06-16",
    });
  });

  it("countUncategorizedActivity coerces a null response to 0", async () => {
    invokeMock.mockResolvedValue(null);
    const { countUncategorizedActivity } = await import("./ipc");
    expect(await countUncategorizedActivity("2026-06-16")).toBe(0);
  });

  it("exportActivityLogCsv forwards the destination and returns the path", async () => {
    invokeMock.mockResolvedValue("/tmp/cairn-activity.csv");
    const { exportActivityLogCsv } = await import("./ipc");
    expect(await exportActivityLogCsv("/tmp/cairn-activity.csv")).toBe(
      "/tmp/cairn-activity.csv",
    );
    expect(invokeMock).toHaveBeenCalledWith("export_activity_log_csv", {
      dest: "/tmp/cairn-activity.csv",
    });
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

  it("billingStatus invokes the command and returns the status (#109)", async () => {
    const status = { enabled: true, license: null };
    invokeMock.mockResolvedValue(status);
    const { billingStatus } = await import("./ipc");
    expect(await billingStatus()).toEqual(status);
    expect(invokeMock).toHaveBeenCalledWith("billing_status");
  });

  it("billing mutators forward the right args to the right commands (#109)", async () => {
    const status = { enabled: true, license: null };
    invokeMock.mockResolvedValue(status);
    const {
      activateBillingLicense,
      refreshBillingLicense,
      deactivateBillingLicense,
    } = await import("./ipc");

    expect(await activateBillingLicense("KEY-1")).toEqual(status);
    expect(invokeMock).toHaveBeenCalledWith("activate_billing_license", {
      license: "KEY-1",
    });
    await refreshBillingLicense();
    expect(invokeMock).toHaveBeenCalledWith("refresh_billing_license");
    await deactivateBillingLicense();
    expect(invokeMock).toHaveBeenCalledWith("deactivate_billing_license");
  });

  it("rate commands forward the right args to the right commands (#109)", async () => {
    invokeMock.mockResolvedValue([]);
    const {
      billingListRates,
      billingSetRate,
      billingDeleteRate,
      billingEffectiveRate,
    } = await import("./ipc");

    await billingListRates();
    expect(invokeMock).toHaveBeenCalledWith("billing_list_rates");

    const rate = {
      scopeType: "client" as const,
      scopeId: "c1",
      amountCents: 15000,
      currency: "USD",
      effectiveFrom: "2026-01-01",
    };
    await billingSetRate(rate);
    expect(invokeMock).toHaveBeenCalledWith("billing_set_rate", rate);

    await billingDeleteRate("r1");
    expect(invokeMock).toHaveBeenCalledWith("billing_delete_rate", {
      id: "r1",
    });

    invokeMock.mockResolvedValue({
      amountCents: 15000,
      currency: "USD",
      scopeType: "client",
      effectiveFrom: "2026-01-01",
    });
    const at = { projectId: "p1", at: "2026-06-01" };
    expect(await billingEffectiveRate(at)).toMatchObject({
      amountCents: 15000,
    });
    expect(invokeMock).toHaveBeenCalledWith("billing_effective_rate", at);
  });

  it("billingProfitability forwards range + rounding (#109)", async () => {
    const rep = {
      from: "a",
      to: "b",
      billableSeconds: 0,
      nonbillableSeconds: 0,
      unratedBillableSeconds: 0,
      totals: [],
      byProject: [],
    };
    invokeMock.mockResolvedValue(rep);
    const { billingProfitability } = await import("./ipc");
    const rounding = { intervalMinutes: 15, mode: "nearest" } as const;
    expect(await billingProfitability("month", rounding)).toEqual(rep);
    expect(invokeMock).toHaveBeenCalledWith("billing_profitability", {
      range: "month",
      rounding,
    });
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

  it("listTasks forwards the project id and coerces a null result to []", async () => {
    invokeMock.mockResolvedValue([{ id: "t1" }]);
    const { listTasks } = await import("./ipc");
    expect(await listTasks("p1")).toEqual([{ id: "t1" }]);
    expect(invokeMock).toHaveBeenCalledWith("list_tasks", { projectId: "p1" });
    // A null projectId is forwarded as null (all tasks).
    await listTasks();
    expect(invokeMock).toHaveBeenLastCalledWith("list_tasks", {
      projectId: null,
    });
    // The a11y-audit stub returns null → guard to [].
    invokeMock.mockResolvedValue(null);
    expect(await listTasks(null)).toEqual([]);
  });

  it("attributeEntryToRemoteTask forwards the input under an `input` key", async () => {
    const result = { entry: { id: "e1" }, task: { id: "t1" } };
    invokeMock.mockResolvedValue(result);
    const { attributeEntryToRemoteTask } = await import("./ipc");
    const input = {
      entryId: "e1",
      connectorId: "github-projects",
      remoteId: "42",
      label: "Fix bug",
      url: "https://github.com/o/r/issues/42",
      remoteProjectName: "Acme",
    };
    const got = await attributeEntryToRemoteTask(input);
    expect(invokeMock).toHaveBeenCalledWith("attribute_entry_to_remote_task", {
      input,
    });
    expect(got).toEqual(result);
  });

  it("setConnectorSecret / clearConnectorSecret forward their args", async () => {
    invokeMock.mockResolvedValue([]);
    const { setConnectorSecret, clearConnectorSecret } = await import("./ipc");
    await setConnectorSecret("remote", "trello_key", "ghp_x");
    expect(invokeMock).toHaveBeenCalledWith("set_connector_secret", {
      connectorId: "remote",
      secretKey: "trello_key",
      token: "ghp_x",
    });
    await clearConnectorSecret("remote", null);
    expect(invokeMock).toHaveBeenCalledWith("clear_connector_secret", {
      connectorId: "remote",
      secretKey: null,
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

  it("setConnectorParam forwards its args and coerces undefined to []", async () => {
    invokeMock.mockResolvedValue(undefined);
    const { setConnectorParam } = await import("./ipc");
    expect(
      await setConnectorParam("github-projects", "owner", "ggsegverse"),
    ).toEqual([]);
    expect(invokeMock).toHaveBeenCalledWith("set_connector_param", {
      connectorId: "github-projects",
      key: "owner",
      value: "ggsegverse",
    });
  });

  it("preview/install connector manifest forward the picked path", async () => {
    const manifest = {
      id: "todoist",
      name: "Todoist",
      capabilities: [],
      kind: {},
    };
    invokeMock.mockResolvedValueOnce(manifest);
    const { previewConnectorManifest, installConnectorManifest } =
      await import("./ipc");
    expect(await previewConnectorManifest("/p.json")).toEqual(manifest);
    expect(invokeMock).toHaveBeenCalledWith("preview_connector_manifest", {
      path: "/p.json",
    });
    invokeMock.mockResolvedValueOnce(undefined); // install coerces to []
    expect(await installConnectorManifest("/p.json")).toEqual([]);
    expect(invokeMock).toHaveBeenCalledWith("install_connector_manifest", {
      path: "/p.json",
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
    expect(await setConnectorSecret("x", null, "t")).toEqual([]);
    expect(await clearConnectorSecret("x", null)).toEqual([]);
  });

  it("getAutostartRepairNotice invokes the command and returns the notice", async () => {
    invokeMock.mockResolvedValue({ message: "repaired" });
    const { getAutostartRepairNotice } = await import("./ipc");
    expect(await getAutostartRepairNotice()).toEqual({ message: "repaired" });
    expect(invokeMock).toHaveBeenCalledWith("get_autostart_repair_notice");
  });

  it("dismissAutostartRepairNotice invokes the command", async () => {
    invokeMock.mockResolvedValue(undefined);
    const { dismissAutostartRepairNotice } = await import("./ipc");
    await dismissAutostartRepairNotice();
    expect(invokeMock).toHaveBeenCalledWith("dismiss_autostart_repair_notice");
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

  it("billing commands short-circuit to an inert status without the backend (#109)", async () => {
    const {
      billingStatus,
      activateBillingLicense,
      refreshBillingLicense,
      deactivateBillingLicense,
    } = await import("./ipc");
    expect(await billingStatus()).toBeNull();
    const inert = { enabled: false, license: null };
    expect(await activateBillingLicense("KEY")).toEqual(inert);
    expect(await refreshBillingLicense()).toEqual(inert);
    expect(await deactivateBillingLicense()).toEqual(inert);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("rate commands short-circuit without the backend (#109)", async () => {
    const {
      billingListRates,
      billingSetRate,
      billingDeleteRate,
      billingEffectiveRate,
      billingProfitability,
    } = await import("./ipc");
    expect(await billingListRates()).toEqual([]);
    expect(
      await billingSetRate({
        scopeType: "workspace",
        scopeId: "",
        amountCents: 1,
        currency: "USD",
        effectiveFrom: "2026-01-01",
      }),
    ).toEqual([]);
    expect(await billingDeleteRate("r1")).toEqual([]);
    expect(await billingEffectiveRate({ at: "2026-01-01" })).toBeNull();
    expect(await billingProfitability("week")).toBeNull();
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

  it("listAppCategories short-circuits to [] without calling the backend", async () => {
    const { listAppCategories } = await import("./ipc");
    expect(await listAppCategories()).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("activity-log commands short-circuit without the backend", async () => {
    const {
      getActivityLogSettings,
      setActivityLogSettings,
      deleteActivityLog,
      listActivityLog,
      countUncategorizedActivity,
      ACTIVITY_LOG_DEFAULTS,
    } = await import("./ipc");
    expect(await getActivityLogSettings()).toEqual(ACTIVITY_LOG_DEFAULTS);
    await setActivityLogSettings({ enabled: true, retentionDays: 1 });
    await deleteActivityLog();
    expect(await listActivityLog("2026-06-16")).toEqual([]);
    expect(await countUncategorizedActivity("2026-06-16")).toBe(0);
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

  it("idleWindowPainted short-circuits without the backend", async () => {
    const { idleWindowPainted } = await import("./ipc");
    await idleWindowPainted();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("showSuggestionNotification short-circuits without the backend (#267)", async () => {
    const { showSuggestionNotification } = await import("./ipc");
    await showSuggestionNotification({
      ruleId: "r1",
      ruleName: "Cairn dev",
      confidence: "suggestive",
      ambiguityBehavior: "prompt",
      project: null,
      tags: [],
      description: "",
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("pendingNotification returns null without the backend (#267)", async () => {
    const { pendingNotification } = await import("./ipc");
    expect(await pendingNotification()).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("dismissSuggestionNotification short-circuits without the backend (#267)", async () => {
    const { dismissSuggestionNotification } = await import("./ipc");
    await dismissSuggestionNotification();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("notificationWindowPainted short-circuits without the backend (#267)", async () => {
    const { notificationWindowPainted } = await import("./ipc");
    await notificationWindowPainted();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("autostartEnabled returns false without the backend", async () => {
    const { autostartEnabled } = await import("./ipc");
    expect(await autostartEnabled()).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("setAutostart echoes the request without the backend", async () => {
    const { setAutostart } = await import("./ipc");
    expect(await setAutostart(true)).toBe(true);
    expect(await setAutostart(false)).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("systemLocale returns null without the backend", async () => {
    const { systemLocale } = await import("./ipc");
    expect(await systemLocale()).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("connector secret commands short-circuit to [] without the backend", async () => {
    const {
      setConnectorSecret,
      clearConnectorSecret,
      setConnectorEnabled,
      setConnectorParam,
    } = await import("./ipc");
    expect(await setConnectorSecret("x", null, "t")).toEqual([]);
    expect(await clearConnectorSecret("x", null)).toEqual([]);
    expect(await setConnectorEnabled("x", false)).toEqual([]);
    expect(await setConnectorParam("x", "owner", "y")).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("preview/install connector manifest short-circuit without the backend", async () => {
    const { previewConnectorManifest, installConnectorManifest } =
      await import("./ipc");
    expect(await previewConnectorManifest("/p.json")).toBeNull();
    expect(await installConnectorManifest("/p.json")).toEqual([]);
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

  it("getAutostartRepairNotice returns a null message without the backend", async () => {
    const { getAutostartRepairNotice } = await import("./ipc");
    expect(await getAutostartRepairNotice()).toEqual({ message: null });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("dismissAutostartRepairNotice short-circuits without the backend", async () => {
    const { dismissAutostartRepairNotice } = await import("./ipc");
    await dismissAutostartRepairNotice();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
