/**
 * Compute the tray-icon title text shown beside the menu-bar icon
 * (tray current-project info). Pure + testable.
 *
 * - feature off → "" (the backend clears the title).
 * - tracking a named project → "{project}".
 * - tracking with no project → "Tracking".
 * - not tracking → "Idle".
 */
export function formatTrayTitle(
  enabled: boolean,
  runningProjectName: string | null | undefined,
  isRunning: boolean,
): string {
  if (!enabled) return "";
  if (!isRunning) return "Idle";
  const name = runningProjectName?.trim();
  return name ? name : "Tracking";
}
