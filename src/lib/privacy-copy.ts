/**
 * Verbatim privacy copy surfaced in Settings → Privacy.
 *
 * The four sentences below are pulled directly from `docs/PRIVACY.md`
 * §"The four guarantees (visible in the app)". They are the user-facing
 * privacy contract; PRIVACY.md states they "appear verbatim in
 * `Settings → Privacy`". Keeping them in a single typed constant lets
 * the snapshot test in `settings.test.tsx` pin the exact string so a
 * stray edit to the JSX cannot drift the copy out of the doc.
 *
 * The structure mirrors the markdown: a bold lead clause followed by
 * the trailing sentence. The renderer joins them with a single space.
 */
export interface PrivacyGuarantee {
  readonly id: "local" | "no-telemetry" | "no-window-titles" | "source";
  readonly lead: string;
  readonly rest: string;
}

export const PRIVACY_GUARANTEES: readonly PrivacyGuarantee[] = [
  {
    id: "local",
    lead: "Everything is stored locally",
    rest: "in a SQLite database under ~/.cairn/ (or platform equivalent). Nothing is uploaded.",
  },
  {
    id: "no-telemetry",
    lead: "No accounts. No telemetry. No background phone-home.",
    rest: 'No analytics, no crash reporting, no "anonymous usage stats". Period.',
  },
  {
    id: "no-window-titles",
    lead: "Window titles are read locally and never leave the device.",
    rest: "They're evaluated against rules in memory and discarded.",
  },
  {
    id: "source",
    lead: "Source on GitHub, Apache 2.0 licensed.",
    rest: "Anyone can audit.",
  },
] as const;

export const PRIVACY_REPO_URL = "https://github.com/drmowinckels/cairn";
export const PRIVACY_REPO_LABEL = "Source on GitHub";
export const PRIVACY_LICENSE_LABEL = "Apache-2.0";

/**
 * Format a byte count for the "View what's stored" secondary list.
 *
 * The contract is intentionally small: bytes for tiny placeholders,
 * KB (kibibytes, integer) up to 1 MiB, MB (mebibytes, one decimal)
 * beyond that. We use 1024-based units because that's what every
 * platform file manager surfaces; the user is comparing what Cairn
 * shows against what Finder / Explorer / Files reports.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}
