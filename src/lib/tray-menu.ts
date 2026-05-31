/**
 * Pure helpers for the enriched tray menu (#104). The popover webview
 * owns the live timer + project list, so it computes the menu model and
 * pushes it to the backend (`updateTrayMenu`) — the same flow the tray
 * title already uses. Keeping the shaping here makes it testable without
 * a Tauri runtime.
 */

/** A project offered in the tray's quick start/switch submenu. */
export interface TrayProject {
  id: string;
  name: string;
}

/** The model the Rust tray renders. Matches `TrayMenuModel` in
 *  `src-tauri/src/tray.rs` (serde camelCase). */
export interface TrayMenuModel {
  statusLabel: string;
  isRunning: boolean;
  projects: TrayProject[];
}

/**
 * Format an elapsed millisecond span as a compact human label:
 * "0m", "5m", "1h 23m". Hours roll up; seconds are dropped (the tray
 * menu isn't a stopwatch — it answers "roughly how long"). Negative or
 * non-finite input clamps to 0m so a clock skew can't render "-3m".
 */
export function formatElapsed(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return "0m";
  const totalMinutes = Math.floor(elapsedMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/**
 * Build the status line shown (disabled) at the top of the tray menu.
 *
 * - not tracking → "Not tracking".
 * - tracking a named project → "Tracking: {project} — {elapsed}".
 * - tracking with no project → "Tracking — {elapsed}".
 */
export function formatTrayStatus(
  isRunning: boolean,
  projectName: string | null | undefined,
  elapsedMs: number,
): string {
  if (!isRunning) return "Not tracking";
  const elapsed = formatElapsed(elapsedMs);
  const name = projectName?.trim();
  return name ? `Tracking: ${name} — ${elapsed}` : `Tracking — ${elapsed}`;
}

/** The running-entry fields the tray model needs. A structural subset
 *  of `BackendEntry`, so the popover can pass the live entry directly. */
export interface TrayRunningEntry {
  projectId: string | null;
}

/**
 * Resolve the display name of the running entry's project, or `null`
 * when nothing is running or the project can't be found. Extracted +
 * exported so both arms are unit-covered here rather than only in a
 * live-timer popover render.
 */
export function resolveRunningProjectName(
  running: TrayRunningEntry | null,
  projects: TrayProject[],
): string | null {
  if (!running || !running.projectId) return null;
  return projects.find((p) => p.id === running.projectId)?.name ?? null;
}

/**
 * Assemble the full tray menu model from the popover's live state.
 * `projects` is passed already display-ordered (the popover filters
 * archived ones out before this point, mirroring `list_projects`).
 * Pass the live running entry (or `null`) directly — the keeps the
 * popover call site free of branching so its coverage doesn't depend on
 * a live timer being present in the render.
 */
export function buildTrayMenuModel(input: {
  running: TrayRunningEntry | null;
  elapsedMs: number;
  projects: TrayProject[];
}): TrayMenuModel {
  const isRunning = input.running !== null;
  return {
    statusLabel: formatTrayStatus(
      isRunning,
      resolveRunningProjectName(input.running, input.projects),
      input.elapsedMs,
    ),
    isRunning,
    projects: input.projects.map((p) => ({ id: p.id, name: p.name })),
  };
}

/** A mutable holder for the last-pushed serialised model. Matches a
 *  React `MutableRefObject<string | null>` so the popover can pass its
 *  ref straight through. */
export interface TrayMenuDedupeRef {
  current: string | null;
}

/**
 * Push `model` to the backend only when it differs from the last push,
 * keying on its JSON serialisation. The native menu rebuild is cheap
 * but not free, and the popover's source state churns (the timer
 * refreshes every ~2s even when unchanged) — deduping keeps the menu
 * from being rebuilt on every tick. Returns whether a push happened, so
 * the change is observable in tests. The branch lives here (rather than
 * inline in the popover effect) so both arms are unit-covered.
 */
export function pushTrayMenuIfChanged(
  model: TrayMenuModel,
  ref: TrayMenuDedupeRef,
  push: (model: TrayMenuModel) => void,
): boolean {
  const serialised = JSON.stringify(model);
  if (serialised === ref.current) return false;
  ref.current = serialised;
  push(model);
  return true;
}
