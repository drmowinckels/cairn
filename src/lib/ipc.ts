import { invoke } from "@tauri-apps/api/core";
import type { Client, IdleResumeEvent, Project, Task } from "./types";

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
}

export async function saveProject(project: SaveProjectInput): Promise<Project> {
  return invoke<Project>("save_project", { project });
}

export async function deleteProject(id: string): Promise<void> {
  await invoke("delete_project", { id });
}

export async function listTasks(projectId?: string | null): Promise<Task[]> {
  if (!inTauri) return [];
  return invoke<Task[]>("list_tasks", { projectId: projectId ?? null });
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

export async function listToday(): Promise<BackendEntry[]> {
  if (!inTauri) return [];
  return invoke<BackendEntry[]>("list_today");
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

export type ReportRange = "day" | "week" | "month";

export interface ReportProjectSlice {
  projectId: string | null;
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
): Promise<ReportSummary | null> {
  if (!inTauri) return null;
  return invoke<ReportSummary>("report_summary", { range });
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

export async function updateEntry(input: UpdateEntryInput): Promise<BackendEntry> {
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

export async function createEntry(input: CreateEntryInput): Promise<BackendEntry> {
  return invoke<BackendEntry>("create_entry", { input });
}

export async function deleteEntry(id: string): Promise<void> {
  await invoke("delete_entry", { id });
}

export async function currentRunning(): Promise<BackendEntry | null> {
  if (!inTauri) return null;
  return invoke<BackendEntry | null>("current_running");
}

export async function startEntry(input: StartEntryInput): Promise<BackendEntry> {
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

export async function setPopoverSize(width: number, height: number): Promise<void> {
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

export async function exportCsv(dest: string): Promise<string> {
  return invoke<string>("export_csv", { dest });
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

export async function resolveIdle(input: ResolveIdleInput): Promise<BackendEntry | null> {
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

export interface SnoozeSnapshot {
  rules: Array<[string, string]>;
  global: string | null;
}

export async function snoozeRule(ruleId: string, durationSeconds: number): Promise<void> {
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
