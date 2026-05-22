import { invoke } from "@tauri-apps/api/core";
import type { Project } from "./types";

export interface BackendEntry {
  id: string;
  projectId: string | null;
  task: string;
  startedAt: string;
  endedAt: string | null;
  source: string;
  ruleId: string | null;
  tags: string[];
}

export interface StartEntryInput {
  projectId?: string | null;
  task: string;
  tags?: string[];
  source?: string;
  ruleId?: string | null;
}

export const inTauri =
  typeof window !== "undefined" &&
  typeof (window as unknown as { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__ !== "undefined";

export async function listProjects(): Promise<Project[]> {
  if (!inTauri) return [];
  return invoke<Project[]>("list_projects");
}

export async function listToday(): Promise<BackendEntry[]> {
  if (!inTauri) return [];
  return invoke<BackendEntry[]>("list_today");
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
