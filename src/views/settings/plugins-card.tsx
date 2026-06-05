import { Icon } from "../../lib/icon";
import { usePlugins } from "../../lib/use-plugins";
import type { PluginCapability } from "../../lib/ipc";

const CAPABILITY: Record<PluginCapability, { label: string; hint: string }> = {
  network: { label: "Network", hint: "Makes network requests" },
  secrets: { label: "Secrets", hint: "Stores credentials in your keychain" },
};

/** Settings → Plugins (#111). Lists each registered signal-source
 *  plugin with the capabilities it declared (so a networked /
 *  secrets-bearing plugin is never active silently — docs/PRIVACY.md)
 *  and a switch to turn it off. Renders nothing when there are no
 *  plugins (e.g. the browser dev harness, where the list is empty). */
export function PluginsCard() {
  const { plugins, busyId, error, toggle } = usePlugins();

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
        Optional signal sources and what they can access. Turn one off to stop
        it entirely.
      </p>
      {error && (
        <p className="privacy-banner privacy-banner--error" role="alert">
          {plugins.length === 0
            ? `Couldn’t load plugins: ${error}`
            : `Couldn’t update the plugin: ${error}`}
        </p>
      )}
      <ul className="intg-list">
        {plugins.map((plugin) => (
          <li
            key={plugin.id}
            className="intg-row"
            data-plugin={plugin.id}
            data-enabled={plugin.enabled}
          >
            <Icon name="grid" size={14} />
            <span className="intg-name">{plugin.name}</span>
            <span className="cap-badges">
              {plugin.capabilities.length === 0 ? (
                <span className="cap-badge cap-badge--local">Local</span>
              ) : (
                plugin.capabilities.map((cap) => (
                  <span
                    key={cap}
                    className="cap-badge"
                    title={CAPABILITY[cap].hint}
                    aria-label={`${CAPABILITY[cap].label}: ${CAPABILITY[cap].hint}`}
                  >
                    {CAPABILITY[cap].label}
                  </span>
                ))
              )}
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
          </li>
        ))}
      </ul>
    </section>
  );
}
