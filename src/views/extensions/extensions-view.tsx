import { IntegrationsCard } from "../settings/integrations";
import { PluginsCard } from "../settings/plugins-card";
import { ConnectorsCard } from "../settings/connectors-card";

/**
 * The Extensions tab — everything optional and opt-in: calendar / browser /
 * git integrations, signal-source plugins, and the PM connectors Cairn reads
 * tasks from. Split out of Settings so day-to-day preferences stay separate
 * from the things you plug in.
 */
export function ExtensionsView() {
  return (
    <div className="view view-extensions">
      <header className="view-head">
        <div>
          <h2 className="view-title">Extensions</h2>
          <p className="view-sub">
            Optional integrations, signal-source plugins, and the project tools
            Cairn reads tasks from. Everything here is opt-in.
          </p>
        </div>
      </header>
      <IntegrationsCard />
      <PluginsCard />
      <ConnectorsCard />
    </div>
  );
}
