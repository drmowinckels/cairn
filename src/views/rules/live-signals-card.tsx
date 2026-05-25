import { Icon, type IconName } from "../../lib/icon";
import type { LiveSignal, SignalKind } from "../../lib/types";
import { SIGNAL_LABELS } from "../../test-fixtures/data";

interface Props {
  signals: LiveSignal[];
  /**
   * Fires when the user clicks a row. The parent decides what to
   * do — typically, add a condition with this signal+value to the
   * currently-open rule, or open / create a rule when none is
   * focused. Optional: pass `undefined` to render rows as plain
   * info (no click affordance).
   */
  onSignalClick?: (signal: SignalKind, value: string) => void;
}

/**
 * The "Live signals" card in the Rules view (DESIGN_SPEC §3.3,
 * medium + heavy complexity). Subscribes upstream to `signal:snapshot`
 * via `useSnapshot()` in the parent; this component is presentation-
 * only so it stays trivially testable with synthetic rows.
 */
export function LiveSignalsCard({ signals, onSignalClick }: Props) {
  return (
    <section className="signals" aria-label="Live signals">
      <div className="sect-label">
        <span>Live signals</span>
        <span className="sect-meta">use these in conditions</span>
      </div>
      {signals.length === 0 ? (
        <p className="sig-empty">
          <em>No signals yet — start using an app.</em>
        </p>
      ) : (
        <ul className="sig-list">
          {signals.map((s, i) => (
            <SignalRow
              key={`${s.signal}-${i}`}
              signal={s}
              onClick={
                onSignalClick
                  ? () => onSignalClick(s.signal, s.value)
                  : undefined
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface RowProps {
  signal: LiveSignal;
  onClick?: () => void;
}

function SignalRow({ signal: s, onClick }: RowProps) {
  const Wrapper = onClick ? "button" : "div";
  return (
    <li className="sig-item">
      <Wrapper
        type={onClick ? "button" : undefined}
        className={onClick ? "sig-row sig-row--clickable" : "sig-row"}
        onClick={onClick}
        aria-label={
          onClick
            ? `Add ${SIGNAL_LABELS[s.signal]} = ${s.value} as a condition`
            : undefined
        }
      >
        <SignalIcon kind={s.signal} />
        <span className="sig-label">{SIGNAL_LABELS[s.signal]}</span>
        <code className="sig-value">{s.value}</code>
        {/* Hide the source-app cell entirely when the snapshot
            didn't observe an app — an empty span eats the grid's
            trailing `auto` column and pushes the layout. */}
        {s.app ? <span className="sig-src">{s.app}</span> : <span />}
      </Wrapper>
    </li>
  );
}

function SignalIcon({ kind }: { kind: SignalKind }) {
  const name: IconName =
    kind === "ide.folder" ? "folder"
    : kind === "git.branch" ? "branch"
    : kind === "browser.domain" ? "globe"
    : kind === "browser.tab" ? "globe"
    : kind === "window.title" ? "type"
    : kind === "calendar.event" ? "calendar"
    : "info";
  return <Icon name={name} size={12} className="sig-ic" />;
}
