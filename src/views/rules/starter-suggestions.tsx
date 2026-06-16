import { useState } from "react";
import { Icon } from "../../lib/icon";
import type { StarterRule } from "../../lib/starter-rules";

interface Props {
  /** Starters still worth suggesting (already-adopted/dismissed filtered out). */
  starters: StarterRule[];
  onAdopt: (starter: StarterRule) => void | Promise<void>;
  onDismiss: (id: string) => void;
  busy?: boolean;
  error?: string | null;
}

/**
 * Collapsible "Suggestions" section in the Rules view (#189). Lists bundled
 * starter rules the user can adopt with one click — nothing is tracked until
 * they do. Adopting creates the named project (if absent) and a real rule.
 */
export function StarterSuggestions({
  starters,
  onAdopt,
  onDismiss,
  busy,
  error,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  if (starters.length === 0) return null;
  return (
    <section className="settings-block" data-section="starter-rules">
      <button
        type="button"
        className="starter-head"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((c) => !c)}
      >
        <Icon name={collapsed ? "chevron-right" : "chevron-down"} size={12} />
        <h3 className="settings-h">Suggestions</h3>
        <span className="starter-count">{starters.length}</span>
      </button>
      {!collapsed && (
        <>
          <p className="settings-sub">
            Starter rules for common apps. Add the ones you want — nothing is
            tracked until you do.
          </p>
          <ul className="starter-list">
            {starters.map((s) => (
              <li className="starter-row" key={s.id}>
                <div className="starter-info">
                  <span className="starter-name">{s.name}</span>
                  <span className="starter-desc">{s.description}</span>
                </div>
                <div className="starter-actions">
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    disabled={busy}
                    onClick={() => void onAdopt(s)}
                  >
                    <Icon name="plus" size={12} /> Add
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={busy}
                    onClick={() => onDismiss(s.id)}
                  >
                    Dismiss
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {error && (
            <p className="now-stop-error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </section>
  );
}
