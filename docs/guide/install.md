# Install

::: warning Public beta
Cairn is in public beta (`v0.0.1-beta`). Expect rough edges — see the [known beta limitations](https://github.com/drmowinckels/cairn/releases/tag/v0.0.1-beta) in the release notes.
:::

Grab the build for your platform from the [latest release](https://github.com/drmowinckels/cairn/releases/latest) — asset names are versioned (e.g. `Cairn_0.0.1_universal.dmg`), so look for the pattern below rather than a fixed link.

## macOS

Download the `*_universal.dmg` (Intel + Apple Silicon in one file). Open it and drag Cairn to Applications.

The build is signed and notarized when release signing secrets are configured for that build — if macOS still shows a "cannot be opened because the developer cannot be verified" dialog, right-click the app and choose **Open** once to bypass it.

Reading window titles needs Accessibility permission — Cairn prompts for it on first launch (**System Settings → Privacy & Security → Accessibility**). Without it, window-title matching silently degrades to "no signal"; nothing crashes.

## Windows

Download the `*_x64_en-US.msi` and run it. Signing is optional per build — if SmartScreen warns, click **More info → Run anyway**.

## Linux

- **`.deb`** (Debian 12 / Ubuntu 22.04+): `sudo dpkg -i Cairn_*_amd64.deb`
- **`.AppImage`** (universal; verified on Ubuntu 22.04 LTS and Fedora 39+): `chmod +x Cairn_*_amd64.AppImage && ./Cairn_*_amd64.AppImage`

Linux bundles aren't code-signed in the conventional sense; integrity is via the release checksums.

## Building from source

Prefer to build it yourself, or on a platform without a prebuilt bundle? See [Getting started](/guide/getting-started).

## Browser extension (optional)

The browser extension tells Cairn which website you're currently on, so a
rule can attribute that time automatically. It is **opt-in** and **fully
local**: only the active tab's **domain** crosses to Cairn — never the URL
path, the page title, page contents, or any tab from a private window — and
nothing leaves your machine. See [Privacy](/PRIVACY#browser-integration).

Enable it in Cairn under **Settings → Plugins → Browser**; the connection
state shows in **Settings → Integrations** ("Connected").

### Safari (macOS)

Safari extensions ship as a small wrapped app rather than a store add-on. The Safari build is currently **dormant** — implemented, but not published as a release asset pending demand — so there's no `Cairn-safari.dmg` to download yet. If you need it now, build it from source (`browser-extension/`); otherwise Chrome/Edge/Brave/Firefox below are ready today. Once published, the flow will be:

1. Install **Cairn for Safari** and drag it to Applications.
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
