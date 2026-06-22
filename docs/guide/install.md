# Install

::: warning Pre-release
Cairn does not yet publish tagged binaries. The only install path today is [building from source](/guide/getting-started).
:::

When the first release ships, install instructions for macOS, Windows, and Linux will land here.

## Browser extension (optional)

The browser extension tells Cairn which website you're currently on, so a
rule can attribute that time automatically. It is **opt-in** and **fully
local**: only the active tab's **domain** crosses to Cairn — never the URL
path, the page title, page contents, or any tab from a private window — and
nothing leaves your machine. See [Privacy](/PRIVACY#browser-integration).

Enable it in Cairn under **Settings → Plugins → Browser**; the connection
state shows in **Settings → Integrations** ("Connected").

### Safari (macOS)

Safari extensions ship as a small wrapped app rather than a store add-on.

1. Install **Cairn for Safari** (`Cairn-safari.dmg`) from the
   [latest release](https://github.com/drmowinckels/cairn/releases) and drag
   it to Applications.
2. Open **Safari → Settings → Extensions** and turn on **Cairn**.
3. Click **Edit Websites** (or the per-site prompt) and grant access — choose
   **Allow** on the sites you want time tracked. Cairn only ever receives the
   domain of whatever tab is in front.
4. Make sure the Browser plugin is enabled in Cairn (**Settings → Plugins**),
   then check **Settings → Integrations** — it should read **Connected**
   within a few seconds of switching tabs.

The extension talks to Cairn over a local socket in the app's App Group
container; it makes no network connections.

### Chrome / Edge / Brave / Firefox

These use a small native-messaging host. Until the extensions are published
to the web stores, follow the developer install in
[`browser-extension/README.md`](https://github.com/drmowinckels/cairn/tree/main/browser-extension#installing-for-local-development).

::: tip macOS: rebuild the native host after upgrading
On macOS the IPC socket lives in the App Group container
(`~/Library/Group Containers/group.io.drmowinckels.cairn/ipc/sock`). If you
installed the Chrome/Firefox native host from an **older** Cairn that used
the previous `Application Support` path, rebuild and reinstall it
(`browser-extension/native-host`) after upgrading — otherwise it connects to
the old path and **Settings → Integrations** stays disconnected.
:::
