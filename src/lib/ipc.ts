import { invoke as tauriInvoke, type InvokeArgs } from "@tauri-apps/api/core";
import { z, type ZodIssue, type ZodType } from "zod";
import type { Project } from "./types";

export class IpcError extends Error {
  readonly command: string;
  readonly issues: ZodIssue[];
  readonly received: unknown;

  constructor(command: string, issues: ZodIssue[], received: unknown) {
    super(
      `IPC response for "${command}" failed schema validation: ${issues
        .map((i) => `${i.path.join(".") || "<root>"} – ${i.message}`)
        .join("; ")}`,
    );
    this.name = "IpcError";
    this.command = command;
    this.issues = issues;
    this.received = received;
  }
}

export async function invoke<T>(
  cmd: string,
  args: InvokeArgs | undefined,
  schema: ZodType<T>,
): Promise<T> {
  const raw = await tauriInvoke(cmd, args);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const err = new IpcError(cmd, parsed.error.issues, raw);
    console.error(err.message, { issues: err.issues, received: raw });
    throw err;
  }
  return parsed.data;
}

export const inTauri =
  typeof window !== "undefined" &&
  typeof (window as unknown as { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__ !== "undefined";

const backendEntrySchema = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  task: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  source: z.string(),
  ruleId: z.string().nullable(),
  tags: z.array(z.string()),
});

const projectSchema: ZodType<Project> = z.object({
  id: z.string(),
  name: z.string(),
  client: z.string().nullable(),
  color: z.string(),
});

const dataPathsSchema = z.object({
  dataDir: z.string(),
  dbPath: z.string(),
  pendingImport: z.string().nullable(),
});

export type BackendEntry = z.infer<typeof backendEntrySchema>;
export type DataPaths = z.infer<typeof dataPathsSchema>;

export interface StartEntryInput {
  projectId?: string | null;
  task: string;
  tags?: string[];
  source?: string;
  ruleId?: string | null;
}

export async function listProjects(): Promise<Project[]> {
  if (!inTauri) return [];
  return invoke("list_projects", undefined, z.array(projectSchema));
}

export async function listToday(): Promise<BackendEntry[]> {
  if (!inTauri) return [];
  return invoke("list_today", undefined, z.array(backendEntrySchema));
}

export async function currentRunning(): Promise<BackendEntry | null> {
  if (!inTauri) return null;
  return invoke("current_running", undefined, backendEntrySchema.nullable());
}

export async function startEntry(input: StartEntryInput): Promise<BackendEntry> {
  return invoke("start_entry", { input }, backendEntrySchema);
}

export async function stopEntry(id: string): Promise<BackendEntry> {
  return invoke("stop_entry", { id }, backendEntrySchema);
}

export async function hidePopover(): Promise<void> {
  if (!inTauri) return;
  await invoke("hide_popover", undefined, z.unknown());
}

export async function dataPaths(): Promise<DataPaths> {
  return invoke("data_paths", undefined, dataPathsSchema);
}

export async function exportBackup(dest: string): Promise<string> {
  return invoke("export_backup", { dest }, z.string());
}

export async function stageImport(src: string): Promise<string> {
  return invoke("stage_import", { src }, z.string());
}

export async function cancelPendingImport(): Promise<void> {
  await invoke("cancel_pending_import", undefined, z.unknown());
}

export async function exportCsv(dest: string): Promise<string> {
  return invoke("export_csv", { dest }, z.string());
}

export async function suggestedBackupName(): Promise<string> {
  return invoke("suggested_backup_name", undefined, z.string());
}

export async function suggestedCsvName(): Promise<string> {
  return invoke("suggested_csv_name", undefined, z.string());
}

export async function deleteEverything(): Promise<void> {
  await invoke("delete_everything", undefined, z.unknown());
}
