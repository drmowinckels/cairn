/**
 * Minimal fzf-style fuzzy ranker for the ⌘K command palette (#32).
 *
 * The ranker is intentionally a single pure function with no deps so
 * the palette can stay light (no `fuzzysort` / `fzf-js` payload) and
 * the scoring is deterministic + testable. The contract:
 *
 *   - Case-insensitive **subsequence** match. Every character of the
 *     query must appear, in order, somewhere in the candidate string.
 *     Non-matches are filtered out (not returned with a low score).
 *   - **Start-of-word bonus.** A query char that lands at index 0,
 *     or right after a separator (space, `-`, `_`, `.`, `/`, `:`),
 *     scores higher than a mid-word match. Makes "sp" rank
 *     "Stop running timer" above "Open settings: privacy".
 *   - **Adjacency bonus.** Consecutive matched chars score higher
 *     than ones separated by gaps — "sp" on "stop" beats "sp" on
 *     "open settings".
 *   - **Tie-break by candidate length.** Shorter candidate first.
 *     "Stop" beats "Stop the running timer" for query "stop".
 *   - **Empty query returns the input order unchanged.** Lets the
 *     palette show all commands sorted by their natural priority
 *     (e.g. MRU) when the input is blank.
 */

export interface Ranked<T> {
  item: T;
  score: number;
}

/**
 * Score a single candidate string against a query. Returns `null`
 * when the candidate is not a subsequence match. Exported so tests
 * can pin the scoring contract directly without going through `rank`.
 */
export function scoreFuzzy(query: string, candidate: string): number | null {
  if (query === "") return 0;
  if (candidate === "") return null;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();

  let score = 0;
  let qi = 0;
  let lastMatch = -2;
  for (let i = 0; i < c.length && qi < q.length; i++) {
    if (c[i] !== q[qi]) continue;
    // Base hit
    score += 1;
    // Start-of-word bonus: index 0 or right after a separator.
    const prev = i === 0 ? "" : c[i - 1];
    if (i === 0 || isSeparator(prev)) score += 8;
    // Adjacency bonus: contiguous match streak.
    if (i === lastMatch + 1) score += 4;
    lastMatch = i;
    qi++;
  }
  if (qi < q.length) return null;
  // Slight nudge for shorter candidates so equally-good matches
  // surface the more concise label. Capped so it can never overturn
  // a real bonus.
  score += Math.max(0, 4 - Math.floor(c.length / 16));
  return score;
}

function isSeparator(ch: string): boolean {
  return ch === " " || ch === "-" || ch === "_" || ch === "." || ch === "/" || ch === ":";
}

/**
 * Rank a list of items against `query`. Items whose `keyOf(item)` is
 * not a subsequence match are dropped. Ties on score are broken by
 * ascending key length, then by original index (stable).
 */
export function rank<T>(query: string, items: T[], keyOf: (item: T) => string): T[] {
  const trimmed = query.trim();
  if (trimmed === "") return items.slice();
  const scored: Array<Ranked<T> & { idx: number; keyLen: number }> = [];
  for (let i = 0; i < items.length; i++) {
    const key = keyOf(items[i]);
    const s = scoreFuzzy(trimmed, key);
    if (s === null) continue;
    scored.push({ item: items[i], score: s, idx: i, keyLen: key.length });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.keyLen !== b.keyLen) return a.keyLen - b.keyLen;
    return a.idx - b.idx;
  });
  return scored.map((s) => s.item);
}
