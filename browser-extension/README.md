# Cairn browser extension

A tiny Manifest V3 extension for Chrome / Edge / Brave / Firefox that
tells your local [Cairn](https://github.com/drmowinckels/cairn) time
tracker which website you're currently looking at — and only that.

This directory holds two things:

- `src/` — the MV3 extension itself (service worker + manifest)
- `native-host/` — the small Rust binary that bridges the
  extension's Native Messaging stream to Cairn's local IPC socket

## What the extension sends

For every tab change in your focused window, the extension forwards
**one JSON line** to the native host, which forwards it to Cairn:

```json
{
  "domain": "github.com",
  "focused": true,
  "incognito": false,
  "browserLabel": "Chrome 120"
}
```

That's it. The extension parses the URL in its own service worker,
keeps only `url.hostname`, and never includes:

- the URL path, query string, or hash
- the page title or any DOM content
- any tab from a private / incognito window (those are flagged
  `incognito: true` and the Cairn collector drops them before they
  reach the rules engine)
- the contents of any cookie, header, or storage value

Internal browser pages (`chrome://`, `about:`, `moz-extension://`,
etc.) are filtered out at the extension boundary, so the native host
never wakes for them either.

## Trust model

This extension talks to **one program on your machine** — the
`cairn-browser-host` binary in this directory — and nothing else. It
has zero remote endpoints, zero analytics, and the only browser
permissions it requests are:

- `tabs` — to read the active tab's URL and incognito flag
- `nativeMessaging` — to launch and pipe to the native host

The native host in turn talks to **one socket** — Cairn's local IPC
endpoint at `~/Library/Group Containers/group.io.drmowinckels.cairn/ipc/sock`
on macOS (the App Group container, shared with the Safari extension so a
sandboxed handler can reach it — #250),
`$XDG_DATA_HOME/io.drmowinckels.cairn/ipc/sock` on Linux, or
`\\.\pipe\cairn` on Windows. The Unix socket lives inside an owner-only
`0700` directory; the named pipe rejects remote clients.

Both halves are Apache-2.0 licensed. The source is small enough to
audit in one sitting — that's by design.

## Installing for local development

1. Build the native host:

   ```bash
   cd native-host
   cargo build --release
   ```

2. Load the extension unpacked:
   - Chrome / Edge / Brave: visit `chrome://extensions`, enable
     "Developer mode", click "Load unpacked", choose this repo's
     `browser-extension/src/` directory.
   - Firefox: visit `about:debugging#/runtime/this-firefox`, click
     "Load Temporary Add-on", choose `browser-extension/src/manifest.json`.

3. Note the extension's ID (Chrome shows it on the card; Firefox
   shows it in `about:debugging`).

4. Register the native host with your browser:

   ```bash
   ./native-host/install.sh <your-extension-id>
   ```

   This drops `io.drmowinckels.cairn.json` into the right
   `NativeMessagingHosts` directory for each installed browser. The
   manifest points at the absolute path of the binary you just built.

5. Start Cairn. You should see "Browser extension: connected" in
   Settings → Integrations within a few seconds of the first tab
   switch.

If the connection doesn't establish, set `CAIRN_HOST_DEBUG=1` in the
environment Cairn launches in (it's read by the host, which logs to
stderr — captured by the browser's extension console).

## Privacy gates summarised

| Stage            | What's dropped                                                       |
| ---------------- | -------------------------------------------------------------------- |
| Browser (worker) | URL → only `hostname`; path/query/hash/title/contents removed        |
| Browser (worker) | Internal schemes (`chrome:`, `about:`, …)                            |
| Native host      | Anything other than `domain`, `incognito`, `focused`, `browserLabel` |
| Native host      | Frames larger than 64 KiB                                            |
| Cairn collector  | `incognito: true` messages                                           |
| Cairn collector  | Unfocused messages (heartbeat only)                                  |
| Cairn collector  | Domains in your exclusion list                                       |
| Cairn collector  | Frames larger than 64 KiB on the socket                              |

Every layer fails closed — if any one of them is unsure, the signal
drops.

## License

Apache-2.0. See `LICENSE`.
