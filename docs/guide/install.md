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

Two installers ship, and which you want depends on whether you can install software as an administrator:

- **`*-setup.exe`** (recommended) — installs for **your user only**, into `%LOCALAPPDATA%`, and needs **no administrator rights**. This is the one to use on a work or school machine where `C:\Program Files` isn't writable.
- **`*_x64_en-US.msi`** — installs **per machine** into `C:\Program Files`, so it needs administrator rights. Use it for a personal machine you administer, or for managed/Group-Policy deployment.

Pick one or the other — installing both leaves two copies of Cairn on the machine, each with its own Start-menu entry. If you're switching, uninstall the first from **Settings → Apps** before running the other.

Either way, signing is optional per build — if SmartScreen warns, click **More info → Run anyway**.

### Scoop

If you manage your tools with [Scoop](https://scoop.sh/), Cairn has its own
bucket:

```powershell
scoop bucket add cairn https://github.com/drmowinckels/cairn
scoop install cairn/cairn-timetracker
```

The name is `cairn-timetracker`, not `cairn` — plain `scoop install cairn`
resolves to [an unrelated app](https://github.com/R0kshan/cairn).

Scoop installs the portable `*-x64-portable.zip` rather than either installer,
so there's no setup program to run and `scoop update cairn-timetracker` is the
whole upgrade. Your data lives in `%APPDATA%\io.drmowinckels.cairn`, outside
Scoop's app directory, so uninstalling leaves your time entries in place.

::: warning From the next release onwards
The portable zip is new, so the bucket is empty until the first release that
ships one — `v0.0.1-beta` predates it. Use one of the installers above in the
meantime.
:::

### Portable zip

`*-x64-portable.zip` is just `Cairn.exe` and the licence: unzip it anywhere you
can write and run it. No installer, no Start-menu entry, no uninstaller.

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
