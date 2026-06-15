# Safari Web Extension (macOS) — scope (#37)

Status: **scoping** (no code yet). This captures the shape of the work,
the one architectural fork that makes it non-trivial, and a slice plan.

## Goal (from #37)

Ship the browser active-tab signal to Safari users, distributed alongside
the main Cairn app, talking to the same local IPC socket, documented in
`docs/guide/install.md`.

Acceptance criteria:

- Xcode project wrapping the MV3 extension's shared code (or a parallel
  Safari-flavored copy).
- Distributed via the GitHub release alongside the main Cairn app.
- Talks to the same Cairn IPC socket.
- Documented in `docs/guide/install.md`.

## What already exists (reuse)

- `browser-extension/src/` — the MV3 extension (service worker + manifest)
  for Chrome/Edge/Brave/Firefox (#36). It computes `url.hostname`, drops
  internal schemes + incognito, and sends one JSON line
  `{domain, focused, incognito, browserLabel}`.
- `browser-extension/native-host/` — a Rust binary bridging **Chrome
  Native Messaging** (length-prefixed stdin frames) to Cairn's IPC socket
  at `~/Library/Application Support/io.drmowinckels.cairn/ipc/sock`
  (macOS). The in-app consumer (#35) is already live.
- macOS signing + notarization infra (#42) and the release pipeline
  (`release.yml`) that builds + notarizes the main app.

## The architectural fork (why this isn't just "wrap it")

**Safari does not support Chrome-style Native Messaging hosts.** There is
no `NativeMessagingHosts` JSON manifest and no standalone host binary the
browser launches. Instead a Safari Web Extension's "native" side is a
**`SafariWebExtensionHandler`** (a Swift `NSExtensionRequestHandling`
class) compiled **into the containing macOS app**, reached from the
extension JS via `browser.runtime.sendNativeMessage(...)`.

So the existing `cairn-browser-host` Rust binary **cannot be the bridge
for Safari**. The wrapper app must carry the bridge itself. Two options:

1. **Swift handler connects to the IPC socket directly.** The
   `SafariWebExtensionHandler` opens the Unix socket
   (`~/Library/Application Support/io.drmowinckels.cairn/ipc/sock`) and
   writes the same newline-delimited JSON line, re-implementing the
   native host's privacy gates (field allowlist, 64 KiB cap) in Swift.
   - Pro: self-contained app, no embedded binary, no spawn.
   - Con: the privacy-gate logic is duplicated in a second language and
     must be kept in lockstep with the Rust host + `docs/PRIVACY.md`.
2. **Swift handler shells out to / embeds `cairn-browser-host`.** Bundle
   the existing Rust binary in the app and pipe to it.
   - Pro: one source of truth for the gates.
   - Con: process spawn per message (or a long-lived child) inside an app
     extension sandbox — fiddly, and app-extension sandboxes restrict
     `exec`. Likely worse than option 1.

**Recommendation: option 1**, with the Swift bridge kept deliberately
tiny and a shared test vector (the documented allowed-field set) asserted
on both the Rust and Swift sides so they can't drift.

## Approach

1. `xcrun safari-web-extension-converter browser-extension/src/` to
   generate the Xcode project (containing app + Safari extension target).
   Commit the generated project under `browser-extension/safari/` (or a
   top-level `safari/`), then hand-edit:
   - Point the extension target at the shared `src/` assets (avoid a
     forked copy if the converter's asset layout allows a symlink/copy
     step; otherwise document the parallel copy and a sync check).
   - Implement `SafariWebExtensionHandler.swift` per option 1.
   - Strip `nativeMessaging` permission (irrelevant in Safari) and the
     `browser_specific_settings.gecko` block for the Safari build;
     reconcile `incognito: "split"` with Safari's private-browsing model.
2. Wire the build into `release.yml`: an `xcodebuild` step on the macOS
   runner that builds + signs (Developer ID) + notarizes the wrapper app,
   emitting a `.app`/`.dmg` uploaded to the same draft release.
3. Document install in `docs/guide/install.md` (currently a stub): enable
   the extension in Safari → Settings → Extensions, grant per-site
   permission, confirm "Browser extension: connected" in Cairn.

## Privacy parity (non-negotiable)

The Safari path must enforce the same gates as the table in
`browser-extension/README.md` / `docs/PRIVACY.md`: hostname-only, drop
internal schemes, drop private-window tabs, field allowlist, 64 KiB cap,
fail-closed. Safari's permission model is stricter (explicit per-site
grant), which is fine — it's more conservative, not less. Update
`docs/PRIVACY.md`'s browser section to note the Safari bridge is the
in-app Swift handler, not the Rust native host.

## Testable in CI vs. manual

- **CI-able:** the Swift bridge's pure logic (field allowlist, frame-size
  cap, JSON shape) as Swift unit tests; an `xcodebuild` smoke build on
  the macOS runner; a converter-output drift check.
- **Manual only:** actually loading the extension in Safari, granting
  permissions, and confirming a real tab switch reaches Cairn. Safari
  extension install/enable is GUI-driven and can't run headless — this is
  the analogue of the #40/#43/#44 manual-verification tail.

## Risks

- App-extension sandbox may restrict opening an arbitrary Unix socket
  outside the app group container. **Validate early** with a throwaway
  handler that just connects + writes one line; if blocked, the socket
  may need to move into / be reachable via an app group, which touches
  the main app's socket path (a core change). This is the single biggest
  unknown — spike it before committing to the slice plan.
- Duplicated privacy gates in Swift drifting from the Rust host.
- `safari-web-extension-converter` output is a large generated Xcode
  project; committing it adds noise and a maintenance surface.
- Distribution outside the Mac App Store needs Developer ID signing +
  notarization of the wrapper app (infra exists from #42, but a second
  notarized artifact lengthens the release run).

## Proposed slices (stacked PRs)

1. **Spike (throwaway):** Swift handler opens the IPC socket and writes
   one line — confirm the sandbox allows it. Decide option 1 vs. escalate
   to app-group socket. (Gate everything below on this.)
2. **Generated wrapper + Swift bridge** with the privacy gates + Swift
   unit tests; manual local Safari smoke test.
3. **Release integration:** `xcodebuild` + sign + notarize + upload in
   `release.yml`.
4. **Docs:** `docs/guide/install.md` Safari section + `docs/PRIVACY.md`
   browser-bridge note.

## Open decisions (need maintainer input)

- Shared `src/` vs. a parallel Safari copy (depends on converter layout).
- Where the Xcode project lives (`browser-extension/safari/` vs `safari/`).
- Whether to commit the generated Xcode project or generate it in CI.
- Confirm the socket-from-app-extension sandbox question (the spike).
