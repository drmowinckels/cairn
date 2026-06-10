import { useEffect, useState } from "react";
import { Icon } from "../../lib/icon";
import { useExclusions, guessExclusionKind } from "../../lib/use-exclusions";

const INCOGNITO_PREF_KEY = "cairn:pause-on-incognito:v1";

/**
 * The "Never track these" list, wired to the exclusion commands
 * (list/save/delete). The add field infers the kind from the input
 * (see `guessExclusionKind`). The incognito toggle has no backend yet —
 * the browser extension will read this preference — so it persists to
 * localStorage rather than the DB.
 *
 * Lives under the Rules tab: an exclusion is the rule that fires before
 * every other rule (a signal that matches it is dropped at the collector),
 * so it belongs next to the rules it pre-empts rather than buried in
 * Settings.
 */
export function ExclusionsSection() {
  const excl = useExclusions();
  const [draft, setDraft] = useState("");
  const [pauseIncognito, setPauseIncognito] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(INCOGNITO_PREF_KEY) !== "false";
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(INCOGNITO_PREF_KEY, String(pauseIncognito));
    } catch {
      /* ignore quota errors */
    }
  }, [pauseIncognito]);

  const submit = () => {
    const value = draft.trim();
    if (!value) return;
    void excl.add(guessExclusionKind(value), value).then(() => setDraft(""));
  };

  return (
    <section className="settings-block" data-section="exclusions">
      <h3 className="settings-h">Never track these</h3>
      <p className="settings-sub">
        Cairn won't observe these apps, URLs, or windows — not even to count
        idle time.
      </p>
      <ul className="excl-list">
        {excl.exclusions.map((e) => (
          <li className="excl-row" key={e.id}>
            <Icon name="lock" size={12} />
            <code>{e.value}</code>
            <span className="excl-kind">{e.kind}</span>
            <button
              className="excl-x"
              aria-label={`Remove ${e.value}`}
              onClick={() => void excl.remove(e.id)}
            >
              <Icon name="x" size={11} />
            </button>
          </li>
        ))}
        <li className="excl-row excl-add">
          <Icon name="plus" size={12} />
          <input
            placeholder="Add an app, domain, or window title pattern…"
            aria-label="Add exclusion"
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
        </li>
      </ul>
      {excl.error && <p className="field-error">{excl.error}</p>}
      <label className="settings-check">
        <input
          type="checkbox"
          checked={pauseIncognito}
          onChange={(e) => setPauseIncognito(e.currentTarget.checked)}
        />
        <span>Pause tracking on private/incognito browser windows</span>
      </label>
    </section>
  );
}
