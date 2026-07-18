import { invoke } from "@tauri-apps/api/core";
import type { Client, IdleResumeEvent, Project, Task } from "./types";
import { ROUNDING_OFF, type Rounding } from "./rounding";
import type { TrayMenuModel } from "./tray-menu";

export interface BackendEntry {
  id: string;
  projectId: string | null;
  taskId: string | null;
  description: string;
  startedAt: string;
  endedAt: string | null;
  source: string;
  ruleId: string | null;
}

export interface StartEntryInput {
  projectId?: string | null;
  taskId?: string | null;
  description?: string;
  source?: string;
  ruleId?: string | null;
}

export const inTauri =
  typeof window !== "undefined" &&
  typeof (window as unknown as { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__ !== "undefined";

/** The OS locale (e.g. `"nb-NO"`), or `null`. The WKWebView reports `en-US`
 *  regardless of the macOS region, so date/time formatting reads the real
 *  locale from the backend instead of `navigator.language`. */
export async function systemLocale(): Promise<string | null> {
  if (!inTauri) return null;
  return invoke<string | null>("system_locale");
}

export async function listClients(): Promise<Client[]> {
  if (!inTauri) return [];
  return invoke<Client[]>("list_clients");
}

export interface SaveClientInput {
  id?: string | null;
  name: string;
  color?: string | null;
  archived?: boolean;
}

export async function saveClient(client: SaveClientInput): Promise<Client> {
  return invoke<Client>("save_client", { client });
}

export async function deleteClient(id: string): Promise<void> {
  await invoke("delete_client", { id });
}

export async function listProjects(): Promise<Project[]> {
  if (!inTauri) return [];
  return invoke<Project[]>("list_projects");
}

export interface SaveProjectInput {
  id?: string | null;
  name: string;
  clientId?: string | null;
  color: string;
  archived?: boolean;
  estimateHours?: number | null;
  /** Per-project rounding override (#107). Omit/`null` = inherit global. */
  rounding?: Rounding | null;
}

export async function saveProject(project: SaveProjectInput): Promise<Project> {
  return invoke<Project>("save_project", { project });
}

export async function deleteProject(id: string): Promise<void> {
  await invoke("delete_project", { id });
}

export async function projectBudgetStatus(
  projectId: string,
): Promise<import("./types").ProjectBudgetStatus> {
  return invoke<import("./types").ProjectBudgetStatus>(
    "project_budget_status",
    { projectId },
  );
}

export async function listTasks(projectId?: string | null): Promise<Task[]> {
  if (!inTauri) return [];
  // `?? []` guards the a11y audit's stubbed `invoke` (returns null), mirroring
  // `listConnectors`; a real backend always returns an array.
  return (
    (await invoke<Task[]>("list_tasks", { projectId: projectId ?? null })) ?? []
  );
}

export interface SaveTaskInput {
  id?: string | null;
  projectId: string;
  name: string;
  archived?: boolean;
}

export async function saveTask(task: SaveTaskInput): Promise<Task> {
  return invoke<Task>("save_task", { task });
}

export async function deleteTask(id: string): Promise<void> {
  await invoke("delete_task", { id });
}

/** Entries for a local day (`YYYY-MM-DD`). The Today view passes today by
 *  default and steps the date back for past-day editing. */
export async function listDay(date: string): Promise<BackendEntry[]> {
  if (!inTauri) return [];
  return invoke<BackendEntry[]>("list_day", { date });
}

export interface BackendWeekDay {
  day: string;
  date: string;
  hours: number;
  segments: Array<[string, number]>;
  today: boolean;
  future: boolean;
  weekend: boolean;
}

export async function listWeek(): Promise<BackendWeekDay[]> {
  if (!inTauri) return [];
  return invoke<BackendWeekDay[]>("list_week");
}

export type ReportRange = "week" | "month" | "quarter" | "year";

export interface ReportProjectSlice {
  projectId: string | null;
  /** The remote project a connector task belongs to (#110), set only when the
   *  slice groups project-less entries attributed to a remote task; `null`
   *  whenever `projectId` is set (the backend always sends it). */
  remoteProjectName?: string | null;
  seconds: number;
}

export interface ReportDayBucket {
  date: string;
  byProject: ReportProjectSlice[];
}

export interface ReportSourceSplit {
  rule: number;
  calendar: number;
  manual: number;
}

export interface ReportSummary {
  totalSeconds: number;
  prevTotalSeconds: number;
  byDay: ReportDayBucket[];
  byProject: ReportProjectSlice[];
  bySource: ReportSourceSplit;
}

export async function reportSummary(
  range: ReportRange,
  rounding: Rounding = ROUNDING_OFF,
): Promise<ReportSummary | null> {
  if (!inTauri) return null;
  return invoke<ReportSummary>("report_summary", { range, rounding });
}

export interface BackendRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  body: unknown;
}

export async function listRules(): Promise<BackendRule[]> {
  if (!inTauri) return [];
  return invoke<BackendRule[]>("list_rules");
}

/** One `app.category` value and the foreground apps that map to it (#189).
 *  Mirrors the Rust `AppCategory` bundled in `app_categories.json`. */
export interface AppCategory {
  category: string;
  label: string;
  apps: string[];
}

/** The bundled app→category table powering the `app.category` rule
 *  condition's helper text. Empty outside Tauri (fixture mode). */
export async function listAppCategories(): Promise<AppCategory[]> {
  if (!inTauri) return [];
  return invoke<AppCategory[]>("list_app_categories");
}

export interface SaveRuleInput {
  id: string | null;
  name: string;
  enabled: boolean;
  priority: number;
  body: unknown;
}

export async function saveRule(rule: SaveRuleInput): Promise<BackendRule> {
  return invoke<BackendRule>("save_rule", { rule });
}

export async function deleteRule(id: string): Promise<void> {
  await invoke("delete_rule", { id });
}

/**
 * Reorder all rules by id (issue #15). The backend assigns dense
 * priorities `10, 20, 30, …` in the order given and reloads the
 * matcher cache so the next snapshot tick uses the new order.
 * Outside Tauri this is a no-op — the frontend optimistic reorder
 * is the only persistence layer in fixture mode.
 */
export async function reorderRules(ids: string[]): Promise<void> {
  if (!inTauri) return;
  await invoke("reorder_rules", { ids });
}

export type ExclusionKind = "app" | "domain" | "window";

export interface BackendExclusion {
  id: string;
  kind: ExclusionKind;
  value: string;
}

export async function listExclusions(): Promise<BackendExclusion[]> {
  if (!inTauri) return [];
  return invoke<BackendExclusion[]>("list_exclusions");
}

export async function saveExclusion(
  kind: ExclusionKind,
  value: string,
): Promise<BackendExclusion> {
  return invoke<BackendExclusion>("save_exclusion", { input: { kind, value } });
}

export async function deleteExclusion(id: string): Promise<void> {
  await invoke("delete_exclusion", { id });
}

export interface UpdateEntryInput {
  id: string;
  projectId?: string | null;
  taskId?: string | null;
  description?: string;
  startedAt?: string;
  endedAt?: string | null;
}

export async function updateEntry(
  input: UpdateEntryInput,
): Promise<BackendEntry> {
  return invoke<BackendEntry>("update_entry", { input });
}

export interface CreateEntryInput {
  projectId?: string | null;
  taskId?: string | null;
  description?: string;
  /** RFC 3339 timestamp. Required. */
  startedAt: string;
  /** RFC 3339 timestamp. `null` / omitted ⇒ open-ended (running). */
  endedAt?: string | null;
  source?: string;
}

export async function createEntry(
  input: CreateEntryInput,
): Promise<BackendEntry> {
  return invoke<BackendEntry>("create_entry", { input });
}

export async function deleteEntry(id: string): Promise<void> {
  await invoke("delete_entry", { id });
}

export async function currentRunning(): Promise<BackendEntry | null> {
  if (!inTauri) return null;
  return invoke<BackendEntry | null>("current_running");
}

export async function startEntry(
  input: StartEntryInput,
): Promise<BackendEntry> {
  return invoke<BackendEntry>("start_entry", { input });
}

export async function stopEntry(id: string): Promise<BackendEntry> {
  return invoke<BackendEntry>("stop_entry", { id });
}

export async function hidePopover(): Promise<void> {
  if (!inTauri) return;
  await invoke("hide_popover");
}

export async function setPinned(pinned: boolean): Promise<void> {
  if (!inTauri) return;
  await invoke("set_pinned", { pinned });
}

export async function setPopoverSize(
  width: number,
  height: number,
): Promise<void> {
  if (!inTauri) return;
  await invoke("set_popover_size", { width, height });
}

export interface DataPaths {
  dataDir: string;
  dbPath: string;
  pendingImport: string | null;
}

export async function dataPaths(): Promise<DataPaths> {
  return invoke<DataPaths>("data_paths");
}

export async function exportBackup(dest: string): Promise<string> {
  return invoke<string>("export_backup", { dest });
}

export async function stageImport(src: string): Promise<string> {
  return invoke<string>("stage_import", { src });
}

export async function cancelPendingImport(): Promise<void> {
  await invoke("cancel_pending_import");
}

export async function exportCsv(
  dest: string,
  rounding: Rounding = ROUNDING_OFF,
): Promise<string> {
  return invoke<string>("export_csv", { dest, rounding });
}

export async function suggestedBackupName(): Promise<string> {
  return invoke<string>("suggested_backup_name");
}

export async function suggestedCsvName(): Promise<string> {
  return invoke<string>("suggested_csv_name");
}

export async function deleteEverything(): Promise<void> {
  await invoke("delete_everything");
}

/**
 * Metadata for a single file under the data directory, surfaced to the
 * UI by the "View what's stored" privacy action. Only file names + byte
 * sizes are read — never file contents (PRIVACY.md, issue #24).
 */
export interface DataFileInfo {
  name: string;
  sizeBytes: number;
}

export async function listDataFiles(): Promise<DataFileInfo[]> {
  if (!inTauri) return [];
  return invoke<DataFileInfo[]>("list_data_files");
}

export async function revealDataFolder(): Promise<void> {
  if (!inTauri) return;
  await invoke("reveal_data_folder");
}

export interface AutoBackupSettings {
  enabled: boolean;
  dir: string | null;
  intervalHours: number;
  keep: number;
}

export interface AutoBackupStatus {
  lastBackupAt: string | null;
  count: number;
}

export const AUTO_BACKUP_DEFAULTS: AutoBackupSettings = {
  enabled: false,
  dir: null,
  intervalHours: 24,
  keep: 14,
};

export async function getAutoBackupSettings(): Promise<AutoBackupSettings> {
  if (!inTauri) return { ...AUTO_BACKUP_DEFAULTS };
  return invoke<AutoBackupSettings>("get_auto_backup_settings");
}

export async function setAutoBackupSettings(
  settings: AutoBackupSettings,
): Promise<AutoBackupSettings> {
  if (!inTauri) return settings;
  return invoke<AutoBackupSettings>("set_auto_backup_settings", { settings });
}

export async function autoBackupStatus(): Promise<AutoBackupStatus> {
  if (!inTauri) return { lastBackupAt: null, count: 0 };
  return invoke<AutoBackupStatus>("auto_backup_status");
}

export async function backupNow(): Promise<string> {
  return invoke<string>("backup_now");
}

export type CalendarKind = "url" | "file";

export interface CalendarSource {
  id: string;
  kind: CalendarKind;
  label: string;
  location: string;
  pollSeconds: number;
  enabled: boolean;
  lastSyncedAt: string | null;
  lastEtag: string | null;
  lastModified: string | null;
  lastError: string | null;
}

export interface AddCalendarInput {
  kind: CalendarKind;
  label: string;
  /**
   * For `url`: full subscription URL including any secret token (stored
   * in the OS keychain; never persisted to SQLite).
   * For `file`: absolute path on disk.
   */
  raw: string;
}

export interface UpdateCalendarInput {
  id: string;
  label?: string;
  pollSeconds?: number;
  enabled?: boolean;
}

export interface ActiveCalendarEvent {
  sourceId: string;
  sourceLabel: string;
  uid: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  attendees: string[];
}

export interface CalendarSyncStatus {
  sourceId: string;
  lastSyncedAt: string | null;
  lastError: string | null;
  eventCount: number;
}

export async function listCalendarSources(): Promise<CalendarSource[]> {
  if (!inTauri) return [];
  return invoke<CalendarSource[]>("list_calendar_sources");
}

export async function addCalendarSource(
  input: AddCalendarInput,
): Promise<CalendarSource> {
  return invoke<CalendarSource>("add_calendar_source", { input });
}

export async function updateCalendarSource(
  input: UpdateCalendarInput,
): Promise<CalendarSource> {
  return invoke<CalendarSource>("update_calendar_source", { input });
}

export async function removeCalendarSource(id: string): Promise<void> {
  await invoke("remove_calendar_source", { id });
}

export async function refreshCalendarSource(
  id: string,
): Promise<CalendarSource> {
  return invoke<CalendarSource>("refresh_calendar_source", { id });
}

export async function currentCalendarEvents(): Promise<ActiveCalendarEvent[]> {
  if (!inTauri) return [];
  return invoke<ActiveCalendarEvent[]>("current_calendar_events");
}

/**
 * Next `limit` calendar events strictly after now, across every
 * enabled source, sorted by start time (#20). Backend clamps `limit`
 * to 1..=10.
 */
export async function upcomingCalendarEvents(
  limit = 3,
): Promise<ActiveCalendarEvent[]> {
  if (!inTauri) return [];
  return invoke<ActiveCalendarEvent[]>("upcoming_calendar_events", { limit });
}

export async function calendarSyncStatus(): Promise<CalendarSyncStatus[]> {
  if (!inTauri) return [];
  return invoke<CalendarSyncStatus[]>("calendar_sync_status");
}

export interface SignalCalendarEvent {
  title: string;
  sourceLabel: string;
  attendees: string[];
  allDay: boolean;
}

/**
 * The live `SignalSnapshot` the rules engine evaluates against. The
 * shape mirrors `rules::SignalSnapshot` 1:1. Today only window + app +
 * calendar are populated; git / browser / IDE folder land in follow-up
 * collector work.
 */
export interface SignalSnapshot {
  ideFolder: string | null;
  gitBranch: string | null;
  windowTitle: string | null;
  appName: string | null;
  browserDomain: string | null;
  calendar: SignalCalendarEvent[];
}

export async function currentSnapshot(): Promise<SignalSnapshot | null> {
  if (!inTauri) return null;
  return invoke<SignalSnapshot>("current_snapshot");
}

/**
 * Seconds since the last user input, or `null` when the host can't report
 * idle (permission denied / unsupported) or we're outside Tauri. Read-only
 * and ephemeral — the working-hours reminder (#99) polls this. No content,
 * just a count, so the privacy contract holds.
 */
export async function idleSeconds(): Promise<number | null> {
  if (!inTauri) return null;
  return invoke<number | null>("idle_seconds");
}

/** Payload of a `dry_run_rules` IPC result. Mirrors `rules::RuleMatch`. */
export interface DryRunResult {
  ruleId: string;
  ruleName: string;
  confidence: "suggestive" | "strict";
  project: string | null;
  tags: string[];
  /** Pre-substituted description (no `{tokens}` left). Empty when the
   *  rule has no `descriptionTemplate`. */
  description: string;
}

/** Snapshot fields the Test bench sends to the backend. Mirrors
 *  `rules::SignalSnapshot` for the fields the bench exposes today
 *  (folder / branch / title); the other fields default server-side. */
export interface DryRunSnapshot {
  ideFolder?: string | null;
  gitBranch?: string | null;
  windowTitle?: string | null;
  appName?: string | null;
  browserDomain?: string | null;
}

/**
 * Evaluate the current rule set against a user-constructed snapshot.
 * Powers the rule editor's Test bench (issue #13). Returns `null`
 * when no rule matches — the bench renders a "no match" row in that
 * case so the user knows the call landed.
 *
 * Outside Tauri (Vite dev / vitest with no IPC mock) we return
 * `null` instead of throwing, so the bench in a fixture-only build
 * shows the no-match state instead of an error.
 */
export async function dryRunRules(
  snapshot: DryRunSnapshot,
): Promise<DryRunResult | null> {
  if (!inTauri) return null;
  return invoke<DryRunResult | null>("dry_run_rules", { snapshot });
}

export type IdleChoice =
  | "keep"
  | "discard"
  | "break"
  | "discard-continue"
  | "new-session";

export interface ResolveIdleInput {
  entryId: string;
  since: string;
  until: string;
  choice: IdleChoice;
}

export async function resolveIdle(
  input: ResolveIdleInput,
): Promise<BackendEntry | null> {
  return invoke<BackendEntry | null>("resolve_idle", { input });
}

export async function pendingIdle(): Promise<IdleResumeEvent | null> {
  if (!inTauri) return null;
  return invoke<IdleResumeEvent | null>("pending_idle");
}

export async function dismissIdle(): Promise<void> {
  if (!inTauri) return;
  await invoke("dismiss_idle");
}

/** Confirm the idle window's webview has painted (#261). The backend shows
 *  the idle prompt click-through until this lands, then makes it interactive
 *  and cancels the paint watchdog — so a webview that never renders can't
 *  become an invisible, always-on-top input trap. */
export async function idleWindowPainted(): Promise<void> {
  if (!inTauri) return;
  await invoke("idle_window_painted");
}

/** Whether launch-at-login is currently registered. */
export async function autostartEnabled(): Promise<boolean> {
  if (!inTauri) return false;
  return invoke<boolean>("autostart_enabled");
}

/** Enable/disable launch-at-login, returning the resulting state. The
 *  backend refuses to register a dev/unpackaged build — which would bake a
 *  `target/debug` path into the login item (#261) — and rejects with an
 *  explanatory message. Outside Tauri this just echoes the request so the
 *  dev-harness toggle still reflects the user's intent. */
export async function setAutostart(enable: boolean): Promise<boolean> {
  if (!inTauri) return enable;
  return invoke<boolean>("set_autostart", { enable });
}

export interface SnoozeSnapshot {
  rules: Array<[string, string]>;
  global: string | null;
}

export async function snoozeRule(
  ruleId: string,
  durationSeconds: number,
): Promise<void> {
  await invoke("snooze_rule", {
    input: { ruleId, durationSeconds },
  });
}

export async function snoozeAll(durationSeconds: number): Promise<void> {
  await invoke("snooze_all", { input: { durationSeconds } });
}

export async function unsnoozeAll(): Promise<void> {
  await invoke("unsnooze_all");
}

export async function listSnoozes(): Promise<SnoozeSnapshot> {
  if (!inTauri) return { rules: [], global: null };
  return invoke<SnoozeSnapshot>("list_snoozes");
}

/**
 * Status payload for the debug "Capture raw signals" mode. Mirrors
 * `signals::capture::CaptureStatus`. Returned by `signal_capture_status`
 * and used by `useSignalCapture` to drive the footer banner.
 */
export interface SignalCaptureStatus {
  active: boolean;
  /** Absolute path of the on-disk ndjson file while active. */
  path: string | null;
  /** Running counter of bytes appended since `start_signal_capture`. */
  bytesWritten: number;
}

/**
 * Start the debug raw-signal capture. Returns the absolute path of
 * the `debug-signals.ndjson` file. The toggle is never persisted; a
 * fresh launch always starts off.
 */
export async function startSignalCapture(): Promise<string> {
  return invoke<string>("start_signal_capture");
}

/**
 * Stop the writer, flush, close, and delete the ndjson file.
 */
export async function stopSignalCapture(): Promise<void> {
  await invoke("stop_signal_capture");
}

/**
 * Poll status for the footer banner. Outside Tauri (Vite dev /
 * vitest) the status is permanently inactive.
 */
export async function signalCaptureStatus(): Promise<SignalCaptureStatus> {
  if (!inTauri) {
    return { active: false, path: null, bytesWritten: 0 };
  }
  return invoke<SignalCaptureStatus>("signal_capture_status");
}

/** Opt-in activity-log settings (#190). Mirrors Rust `ActivityLogSettings`.
 *  `retentionDays === 0` means "keep until I delete". */
export interface ActivityLogSettings {
  enabled: boolean;
  retentionDays: number;
}

export const ACTIVITY_LOG_DEFAULTS: ActivityLogSettings = {
  enabled: false,
  retentionDays: 7,
};

export async function getActivityLogSettings(): Promise<ActivityLogSettings> {
  if (!inTauri) return ACTIVITY_LOG_DEFAULTS;
  // A stubbed invoke (tests / a11y audit harness) resolves null for un-mocked
  // commands; never hand the UI a non-object it would deref.
  return (
    (await invoke<ActivityLogSettings>("get_activity_log_settings")) ??
    ACTIVITY_LOG_DEFAULTS
  );
}

/** Persist the toggle + retention. Enabling starts recording + applies
 *  retention; disabling stops recording and purges every row (backend). */
export async function setActivityLogSettings(
  settings: ActivityLogSettings,
): Promise<void> {
  if (!inTauri) return;
  await invoke("set_activity_log_settings", { settings });
}

/** Hard-delete every activity-log row now, leaving the toggle untouched. */
export async function deleteActivityLog(): Promise<void> {
  if (!inTauri) return;
  await invoke("delete_activity_log");
}

/** One recorded activity span (#190). Mirrors Rust `ActivityRow`. */
export interface ActivityRow {
  id: number;
  startedAt: string;
  endedAt: string;
  appName: string;
  titleHint: string | null;
  source: string;
}

/** The recorded spans for a local day (`YYYY-MM-DD`), oldest first. Empty
 *  outside Tauri. */
export async function listActivityLog(date: string): Promise<ActivityRow[]> {
  if (!inTauri) return [];
  return (await invoke<ActivityRow[]>("list_activity_log", { date })) ?? [];
}

/** Write the whole activity log to `dest` as CSV; returns the path written.
 *  Separate from the entries export, which never touches this table (#190). */
export async function exportActivityLogCsv(dest: string): Promise<string> {
  return invoke<string>("export_activity_log_csv", { dest });
}

/**
 * Snapshot of the single-row `app_state` marker (issue #31). When
 * `completedAt` is `null` the popover renders the onboarding overlay
 * instead of the main view.
 */
export interface OnboardingState {
  completedAt: string | null;
}

/**
 * Read the onboarding marker. Outside Tauri the flow is implicitly
 * "completed" so the fixture-only dev mode doesn't trap the developer
 * in the onboarding overlay on every Vite reload.
 */
export async function getOnboardingState(): Promise<OnboardingState> {
  if (!inTauri) return { completedAt: new Date(0).toISOString() };
  return invoke<OnboardingState>("get_onboarding_state");
}

export async function completeOnboarding(): Promise<OnboardingState> {
  if (!inTauri) return { completedAt: new Date().toISOString() };
  return invoke<OnboardingState>("complete_onboarding");
}

export async function resetOnboarding(): Promise<OnboardingState> {
  if (!inTauri) return { completedAt: null };
  return invoke<OnboardingState>("reset_onboarding");
}

/**
 * One-time notice (#264) surfaced in Settings → Integrations when
 * startup detected and repaired a stale launch-at-login LaunchAgent —
 * one baked before #263's dev-build guard existed, still pointing at a
 * since-removed dev build or a relocated/uninstalled bundle. `message`
 * is `null` once nothing was ever repaired, or after it's dismissed.
 */
export interface AutostartRepairNotice {
  message: string | null;
}

export async function getAutostartRepairNotice(): Promise<AutostartRepairNotice> {
  if (!inTauri) return { message: null };
  return invoke<AutostartRepairNotice>("get_autostart_repair_notice");
}

export async function dismissAutostartRepairNotice(): Promise<void> {
  if (!inTauri) return;
  await invoke("dismiss_autostart_repair_notice");
}

export async function setTrayTitle(title: string): Promise<void> {
  if (!inTauri) return;
  await invoke("set_tray_title", { title });
}

export async function updateTrayMenu(model: TrayMenuModel): Promise<void> {
  if (!inTauri) return;
  await invoke("update_tray_menu", { model });
}

export interface Diagnostics {
  appVersion: string;
  os: string;
  arch: string;
  projects: number;
  clients: number;
  rules: number;
  exclusions: number;
  entries: number;
}

export async function diagnostics(): Promise<Diagnostics | null> {
  if (!inTauri) return null;
  return invoke<Diagnostics>("diagnostics");
}

export interface GitWatcherStatus {
  discoveryRoots: string[];
  watchedCount: number;
}

export async function getGitWatcherStatus(): Promise<GitWatcherStatus | null> {
  if (!inTauri) return null;
  return invoke<GitWatcherStatus>("get_git_watcher_status");
}

export async function getGitDiscoveryRoots(): Promise<string[]> {
  if (!inTauri) return ["~/code"];
  return invoke<string[]>("get_git_discovery_roots");
}

export async function setGitDiscoveryRoots(
  roots: string[],
): Promise<GitWatcherStatus> {
  if (!inTauri) return { discoveryRoots: roots, watchedCount: 0 };
  return invoke<GitWatcherStatus>("set_git_discovery_roots", { roots });
}

export interface BrowserExtensionStatus {
  connected: boolean;
  lastSeen: string | null;
  browserLabel: string | null;
}

export async function browserExtensionStatus(): Promise<BrowserExtensionStatus | null> {
  if (!inTauri) return null;
  return invoke<BrowserExtensionStatus>("browser_extension_status");
}

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes: string | null;
  releaseUrl: string;
}

/**
 * Opt-in update check (#45). Performs a single HTTPS GET of the release
 * manifest via tauri-plugin-updater and returns the newer version's info,
 * or null when up to date / outside Tauri. Callers must only invoke this
 * when the user has enabled "Check for updates" (see useUpdatePrefs).
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!inTauri) return null;
  return invoke<UpdateInfo | null>("check_for_update");
}

/** A capability a signal-source plugin declares (mirrors the Rust
 *  `Capability` enum, kebab-serialized). Surfaced as a badge so the
 *  privacy posture of an optional plugin is visible (docs/PRIVACY.md). */
export type PluginCapability = "network" | "secrets";

export interface Plugin {
  id: string;
  name: string;
  capabilities: PluginCapability[];
  enabled: boolean;
}

/** Registered signal-source plugins with their capabilities + enabled
 *  state (#111). Empty outside Tauri so the Settings card simply hides.
 *  The `?? []` guards a stubbed `invoke` (the a11y audit harness) that
 *  resolves `undefined` for un-mocked commands — never hand the UI a
 *  non-array it would call `.length` on. */
export async function listPlugins(): Promise<Plugin[]> {
  if (!inTauri) return [];
  return (await invoke<Plugin[]>("list_plugins")) ?? [];
}

/** Enable/disable a plugin; returns the updated list. No-op (empty)
 *  outside Tauri so the dev harness keeps the optimistic UI state. */
export async function setPluginEnabled(
  id: string,
  enabled: boolean,
): Promise<Plugin[]> {
  if (!inTauri) return [];
  return (await invoke<Plugin[]>("set_plugin_enabled", { id, enabled })) ?? [];
}

/** A capability a PM connector declares (mirrors the Rust `Capability`,
 *  kebab-serialized). A local-file connector declares none. */
export type ConnectorCapability = "network" | "secrets";

export type ConnectorFileFormat = "todotxt" | "markdown" | "taskpaper";

/** The connector's interpreter + its config (mirrors Rust `ConnectorKind`,
 *  externally tagged): a local file read by a built-in parser, or a remote
 *  read by the declarative HTTP interpreter. The http variant carries more
 *  than `baseUrl` on the wire (auth key, operations); the card only needs
 *  the host it contacts. */
export type ConnectorKind =
  | { file: { format: ConnectorFileFormat; path: string } }
  | { http: { baseUrl: string } };

/** Whether one of a connector's secrets is present (mirrors Rust
 *  `SecretState`). `missing` — needed but not stored; `set` — in the keychain.
 *  A connector needing no secret has an empty `secrets` list (there is no
 *  "not required" per secret). The token itself never crosses IPC. */
export type ConnectorSecretState = "missing" | "set";

/** One secret a connector needs (mirrors Rust `SecretView`): its keychain
 *  `key` (passed back to set/clear it), a human `label` for the field, and
 *  whether a token is stored. */
export interface ConnectorSecret {
  key: string;
  label: string;
  state: ConnectorSecretState;
}

/** One configuration param a connector declares (mirrors Rust `ParamView`):
 *  its `key` (passed back to set/clear it), a human `label`, an optional
 *  `placeholder` hint, and the stored `value` (empty ⇒ unset). Unlike a
 *  secret, the value is not sensitive and round-trips so the field shows it. */
export interface ConnectorParam {
  key: string;
  label: string;
  placeholder: string | null;
  value: string;
}

/** A connector manifest as validated by the backend (mirrors Rust
 *  `ConnectorManifest`) — what `previewConnectorManifest` returns so the
 *  import UI can show what would be installed before committing. */
export interface ConnectorManifest {
  id: string;
  name: string;
  capabilities: ConnectorCapability[];
  kind: ConnectorKind;
}

export interface Connector {
  id: string;
  name: string;
  capabilities: ConnectorCapability[];
  kind: ConnectorKind;
  /** The secrets this connector needs, one card field each. Empty ⇒ none
   *  (a local file, or `auth: none`). */
  secrets: ConnectorSecret[];
  /** The configuration params this connector declares, one editable field
   *  each (e.g. the GitHub `owner`). Empty ⇒ none. */
  params: ConnectorParam[];
  /** Whether the user has this connector enabled. A disabled connector is
   *  listed but makes no requests — browsing it is refused. */
  enabled: boolean;
}

/** A project as seen in the connected planner. */
export interface RemoteProject {
  id: string;
  name: string;
  description: string | null;
}

/** A task as seen in the connected planner. */
export interface RemoteTask {
  id: string;
  label: string;
  url: string | null;
  status: string | null;
  done: boolean;
}

/** Loaded PM connectors (#110). Empty outside Tauri so the Settings card
 *  hides; `?? []` guards the a11y audit's stubbed `invoke` (see
 *  `listPlugins`). */
export async function listConnectors(): Promise<Connector[]> {
  if (!inTauri) return [];
  return (await invoke<Connector[]>("list_connectors")) ?? [];
}

/** Store a connector's auth token in the OS keychain (#110), returning the
 *  refreshed connector list so the card can flip the badge to "set". The
 *  token is write-only — it is never read back. No-ops outside Tauri. */
export async function setConnectorSecret(
  connectorId: string,
  secretKey: string | null,
  token: string,
): Promise<Connector[]> {
  if (!inTauri) return [];
  return (
    (await invoke<Connector[]>("set_connector_secret", {
      connectorId,
      secretKey,
      token,
    })) ?? []
  );
}

/** Clear a connector's stored auth token, returning the refreshed list.
 *  `secretKey` names which one for a multi-secret connector. */
export async function clearConnectorSecret(
  connectorId: string,
  secretKey: string | null,
): Promise<Connector[]> {
  if (!inTauri) return [];
  return (
    (await invoke<Connector[]>("clear_connector_secret", {
      connectorId,
      secretKey,
    })) ?? []
  );
}

/** Enable or disable a connector (#110), returning the refreshed list. A
 *  disabled connector makes no requests — browsing it is refused. */
export async function setConnectorEnabled(
  connectorId: string,
  enabled: boolean,
): Promise<Connector[]> {
  if (!inTauri) return [];
  return (
    (await invoke<Connector[]>("set_connector_enabled", {
      connectorId,
      enabled,
    })) ?? []
  );
}

/** Set or clear a connector's configuration param (#110), returning the
 *  refreshed list so the card reflects the new value. An empty `value` clears
 *  it. Unlike a token, the value is not secret and is shown back. */
export async function setConnectorParam(
  connectorId: string,
  key: string,
  value: string,
): Promise<Connector[]> {
  if (!inTauri) return [];
  return (
    (await invoke<Connector[]>("set_connector_param", {
      connectorId,
      key,
      value,
    })) ?? []
  );
}

/** Validate a picked connector-manifest file WITHOUT installing it (#110),
 *  so the import UI can show what it would add (host, capabilities) for
 *  consent. Returns null outside Tauri. */
export async function previewConnectorManifest(
  path: string,
): Promise<ConnectorManifest | null> {
  if (!inTauri) return null;
  return invoke<ConnectorManifest>("preview_connector_manifest", { path });
}

/** Install a picked connector-manifest file (#110): copies it into the
 *  connectors dir and hot-reloads. Returns the refreshed connector list. */
export async function installConnectorManifest(
  path: string,
): Promise<Connector[]> {
  if (!inTauri) return [];
  return (
    (await invoke<Connector[]>("install_connector_manifest", { path })) ?? []
  );
}

/** A connector read paired with its freshness (mirrors Rust `CachedList`).
 *  `stale` means the live read failed and `items` came from the offline
 *  cache; `fetchedAt` is when the snapshot was taken (RFC 3339). */
export interface CachedList<T> {
  items: T[];
  stale: boolean;
  fetchedAt: string | null;
}

export function emptyList<T>(): CachedList<T> {
  return { items: [], stale: false, fetchedAt: null };
}

/** A connector's projects, through the offline cache. */
export async function listConnectorProjects(
  connectorId: string,
): Promise<CachedList<RemoteProject>> {
  if (!inTauri) return emptyList();
  return (
    (await invoke<CachedList<RemoteProject>>("list_connector_projects", {
      connectorId,
    })) ?? emptyList()
  );
}

/** The tasks in one of a connector's projects, through the offline cache. */
export async function listConnectorTasks(
  connectorId: string,
  projectId: string,
): Promise<CachedList<RemoteTask>> {
  if (!inTauri) return emptyList();
  return (
    (await invoke<CachedList<RemoteTask>>("list_connector_tasks", {
      connectorId,
      projectId,
    })) ?? emptyList()
  );
}

/** Identity of a connector task to attribute an entry to (#110). The fields
 *  come from a `RemoteTask` the UI already fetched via `listConnectorTasks`,
 *  plus the connector + remote-project context needed to intern it. */
export interface AttributeRemoteTaskInput {
  entryId: string;
  connectorId: string;
  remoteId: string;
  label: string;
  url?: string | null;
  remoteProjectName?: string | null;
}

/** The result of attributing an entry: the updated entry plus the interned
 *  task it now points at. Mirrors the Rust `AttributedEntry`. */
export interface AttributedEntry {
  entry: BackendEntry;
  task: Task;
}

/** Attribute a time entry to a remote PM-connector task (#110): interns the
 *  task into the local `tasks` table and points the entry's `taskId` at it.
 *  The connector must be enabled. Throws outside Tauri — it is only ever
 *  invoked from a real attribution action, never during a stubbed render. */
export async function attributeEntryToRemoteTask(
  input: AttributeRemoteTaskInput,
): Promise<AttributedEntry> {
  return invoke<AttributedEntry>("attribute_entry_to_remote_task", { input });
}
