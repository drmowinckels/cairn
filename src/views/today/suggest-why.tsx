import { Fragment } from "react";
import type { MatchedSignal, SignalKind } from "../../lib/types";

/**
 * Short prefix shown before a matched signal's mono value chip in the
 * suggestion banner's "why" line (#143), e.g. `folder ~/code/cairn`.
 * `git.branch` is shown bare — the branch name reads as its own
 * evidence and the spec example leads with it unprefixed
 * (`because feat/rules-ui · folder ~/code/cairn`, DESIGN_SPEC §3.1a).
 */
const SIGNAL_WHY_LABELS: Record<SignalKind, string> = {
  "git.branch": "",
  "ide.folder": "folder",
  "window.title": "window",
  "app.name": "app",
  "app.category": "category",
  "browser.domain": "site",
  // Dead entry: the Rust `Condition` enum has no `BrowserTab` variant, so
  // `collect_matched_signals` never emits "browser.tab"; it exists only to
  // satisfy the `Record<SignalKind, string>` exhaustiveness check.
  "browser.tab": "tab",
  "calendar.event": "meeting",
};

const MAX_CHIP_LEN = 40;

export function truncateMiddle(value: string, max = MAX_CHIP_LEN): string {
  if (value.length <= max) return value;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

/**
 * The "why" evidence chips for the suggestion banner: `because` followed
 * by the live signal values that contributed to the match, each in a
 * faint mono code chip, separated by ` · ` (#143).
 *
 * Render-only: these values are never persisted. The backend builds
 * them from the already-redacted snapshot, so an excluded
 * app/window/domain can never reach this component. Renders nothing
 * when there are no matched signals (e.g. a payload from before #143).
 */
export function SuggestWhy({ signals }: { signals: MatchedSignal[] }) {
  if (signals.length === 0) return null;
  return (
    <span className="suggest-why-evidence">
      because{" "}
      {signals.map((s, i) => {
        const label = SIGNAL_WHY_LABELS[s.signal];
        return (
          <Fragment key={`${s.signal}:${s.value}`}>
            {i > 0 && <span className="suggest-why-sep"> · </span>}
            {label && <span className="suggest-why-label">{label} </span>}
            <code>{truncateMiddle(s.value)}</code>
          </Fragment>
        );
      })}
    </span>
  );
}
