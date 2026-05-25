import { invoke } from "@tauri-apps/api/core";
import type { Client, Project, Task } from "./types";

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

export type IdleChoice = "keep" | "discard" | "break";

export interface ResolveIdleInput {
  entryId: string;
  since: string;
  until: string;
  choice: IdleChoice;
}

export async function resolveIdle(input: ResolveIdleInput): Promise<BackendEntry | null> {
  return invoke<BackendEntry | null>("resolve_idle", { input });
}
