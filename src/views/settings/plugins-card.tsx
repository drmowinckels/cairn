import { CapabilityBadges } from "../../lib/components";
import { Icon } from "../../lib/icon";
import { usePlugins } from "../../lib/use-plugins";
import { BillingDetail } from "./billing-license";

/** Plugins surfaced elsewhere in the UI, hidden from this list to avoid
 *  listing them twice. Calendar has its own Integrations row (with the
 *  source-management flow), so it is not also shown as a plugin toggle. */
const HIDDEN_PLUGIN_IDS = new Set(["calendar"]);

/** Extra per-plugin detail rendered under the toggle while the plugin is
 *  enabled — keeps the list renderer generic instead of special-casing
 *  plugin ids inline. Billing's row manages the Pro license (#109). */
const PLUGIN_DETAIL: Record<string, React.ComponentType> = {
  billing: BillingDetail,
};

/** Settings → Plugins (#111). Lists each registered signal-source
 *  plugin with the capabilities it declared (so a networked /
 *  secrets-bearing plugin is never active silently — docs/PRIVACY.md)
 *  and a switch to turn it off. Renders nothing when there are no
 *  plugins (e.g. the browser dev harness, where the list is empty). */
export function PluginsCard() {
  const { plugins: allPlugins, busyId, error, toggle } = usePlugins();
  const plugins = allPlugins.filter((p) => !HIDDEN_PLUGIN_IDS.has(p.id));

  // Hide only when there is genuinely nothing to show: no plugins AND no
  // error (still loading, the browser dev harness, or no plugins built
  // in). A load/toggle failure keeps the card so the error is visible.
  if (plugins.length === 0 && !error) return null;

  return (
    <section
      className="settings-block"
      aria-label="Plugins"
      data-section="plugins"
    >
      <h3 className="settings-h">Plugins</h3>
      <p className="settings-sub">
        Optional plugins — signal sources and Pro features — and what they can
        access. Turn one off to stop it entirely.
      </p>
      {error && (
        <p className="privacy-banner privacy-banner--error" role="alert">
          {plugins.length === 0
            ? `Couldn’t load plugins: ${error}`
            : `Couldn’t update the plugin: ${error}`}
        </p>
      )}
      <ul className="intg-list">
        {plugins.map((plugin) => {
          const Detail = PLUGIN_DETAIL[plugin.id];
          return (
            <li
              key={plugin.id}
              className="intg-row"
              data-plugin={plugin.id}
              data-enabled={plugin.enabled}
            >
              <Icon name="grid" size={14} />
              <span className="intg-name">{plugin.name}</span>
              <span className="cap-badges">
                <CapabilityBadges capabilities={plugin.capabilities} />
              </span>
              <button
                type="button"
                className={`tgl${plugin.enabled ? " is-on" : ""}`}
                role="switch"
                aria-checked={plugin.enabled}
                aria-label={`Enable ${plugin.name}`}
                onClick={() => {
                  void toggle(plugin.id, !plugin.enabled);
                }}
                disabled={busyId === plugin.id}
              >
                <span className="tgl-dot" />
              </button>
              {Detail && plugin.enabled && <Detail />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
