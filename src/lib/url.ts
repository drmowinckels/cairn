/** Whether `url` is safe to hand to the OS opener as an external link.
 *
 *  Remote-task URLs come from a PM connector's API response (stored verbatim
 *  in PR1), so they are attacker-influenceable. Before opening one we allow
 *  only `http`/`https` — a `javascript:`, `file:`, or `data:` URL must never
 *  reach `openUrl`. Parse failures are rejected. */
export function isSafeExternalUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" || parsed.protocol === "http:";
}
