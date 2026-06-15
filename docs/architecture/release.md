# Release signing & certificate rotation

This is the architecture-level reference for how Cairn's distributable
bundles are signed, and the runbook for rotating the macOS signing
certificate. For the step-by-step "how to cut a release", see
[`RELEASING.md`](https://github.com/drmowinckels/cairn/blob/main/RELEASING.md) at the repo root.

## Why we sign

Cairn is distributed **outside** the Mac App Store and the Microsoft
Store. Without a valid signature + notarization, macOS Gatekeeper blocks
the app with a "cannot be opened because the developer cannot be
verified" dialog, and Windows SmartScreen warns on every install. Signing
is purely a distribution-trust concern — it changes nothing about Cairn's
local-first privacy model.

## macOS: signing + notarization

The pipeline uses [`tauri-action`](https://github.com/tauri-apps/tauri-action),
which wraps the native toolchain:

1. **Sign** every Mach-O (the app binary, the embedded helper, the
   frameworks) with the **Developer ID Application** certificate, under
   the **hardened runtime**, applying
   [`src-tauri/entitlements.plist`](https://github.com/drmowinckels/cairn/blob/main/src-tauri/entitlements.plist).
2. **Notarize** the `.dmg` by submitting it to Apple
   (`xcrun notarytool submit --wait`). Apple scans it and issues a
   ticket.
3. **Staple** the ticket onto both the `.app` and the `.dmg`
   (`xcrun stapler staple`) so Gatekeeper validates offline.

### Entitlements

The entitlements file is intentionally minimal — just
`com.apple.security.network.client` for outbound ICS calendar fetches
and the opt-in update check. Rationale and the explicit "not granted"
list live as comments in the plist itself. Reading window **titles**
uses the Accessibility API, which is a runtime TCC grant (System
Settings → Privacy & Security → Accessibility), **not** an entitlement —
signing is only what lets Cairn appear in that list.

### Signing identity

`APPLE_SIGNING_IDENTITY` is supplied as a CI secret rather than hardcoded
in `tauri.conf.json`, so the repo carries no developer-specific string
and the identity can rotate without a code change. Tauri reads it from
the environment when `bundle.macOS.signingIdentity` is unset (which it
is).

## Certificate-rotation runbook (macOS)

Developer ID Application certificates are valid for 5 years, but rotate
sooner if the private key is exposed (e.g. a leaked `.p12`, a
compromised CI secret, or an offboarded maintainer who held the key).

### Routine rotation (expiry approaching)

1. **Create the new cert.** Apple Developer portal → Certificates → **+**
   → _Developer ID Application_. Generate a CSR from Keychain Access
   (Keychain Access → Certificate Assistant → Request a Certificate from
   a Certificate Authority) and upload it. Download the new `.cer`.
2. **Import & export.** Double-click the `.cer` to import into Keychain;
   export it together with its private key as a password-protected
   `.p12`.
3. **Update secrets** (see RELEASING.md for the exact names):
   - `APPLE_CERTIFICATE` ← `base64 -i NewCert.p12`
   - `APPLE_CERTIFICATE_PASSWORD` ← the new export password
   - `APPLE_SIGNING_IDENTITY` ← new string from
     `security find-identity -v -p codesigning`
     (the Team ID in parentheses is unchanged; the cert serial differs).
4. **Dry-run.** Trigger the Release workflow via `workflow_dispatch` on
   the last released tag and confirm the macOS job signs + notarizes
   green. **Do not** publish the resulting draft — delete it; it's only
   a smoke test.
5. **Revoke the old cert** in the Developer portal once the new one is
   proven. Already-stapled, already-shipped builds keep working — the
   ticket is independent of cert validity — so users are unaffected.

### Emergency rotation (key compromise)

1. **Revoke immediately** in the Developer portal. This does **not**
   invalidate already-notarized builds (their tickets stand), but stops
   new signing with the leaked key.
2. Rotate the secrets as above.
3. **Purge the leaked material**: rotate the `APPLE_CERTIFICATE` /
   `APPLE_CERTIFICATE_PASSWORD` secrets, and if the app-specific
   password may also be exposed, revoke it at appleid.apple.com and
   reissue `APPLE_PASSWORD`.
4. Re-cut any in-flight release from a clean run.

### Notarization credential rotation

The `APPLE_PASSWORD` app-specific password is separate from the cert.
Rotate it at appleid.apple.com → Sign-In & Security → App-Specific
Passwords; it does not require a new certificate. If you migrate to an
App Store Connect API key instead, swap the `env:` block in
`release.yml` to `APPLE_API_ISSUER` / `APPLE_API_KEY` /
`APPLE_API_KEY_PATH` and store the `.p8` as a secret.

## Windows & Linux

- **Windows (#43):** the Windows job builds a WiX **MSI** (Start-menu
  shortcut + uninstaller) and Authenticode-signs it when the optional
  `WINDOWS_CERTIFICATE` / `WINDOWS_CERTIFICATE_PASSWORD` secrets are set,
  mirroring the optional Apple secrets — unsigned otherwise. SmartScreen
  warns on an unsigned or self-signed installer; an OV cert gains
  reputation over time and an EV cert clears it immediately. Signing
  config (`certificateThumbprint` + timestamp) is generated in CI into
  `tauri.windows.conf.json` and merged via RFC 7396, so the thumbprint
  never lives in the repo. **Rotation:** export the replacement `.pfx`,
  update the two secrets, and re-cut the release — no config change, since
  the thumbprint is read from the imported cert at build time.
- **Linux (#44):** the Linux job builds a `.deb` (Debian 12 /
  Ubuntu 22.04+) and an AppImage (universal — verified targets are
  Ubuntu 22.04 LTS and Fedora 39+). Both are pinned via
  `--bundles deb,appimage`; `rpm` is intentionally not shipped since
  AppImage covers Fedora and an Ubuntu-built rpm carries
  Debian-style dependency names. Building on `ubuntu-22.04` (glibc 2.35)
  keeps both bundles compatible with newer distros. `.deb` runtime deps
  are declared in `tauri.conf.json` (`bundle.linux.deb.depends`). Linux
  bundles are not signed in the conventional sense; integrity is via the
  release checksums.

## Where things live

| Concern                  | Location                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Pipeline                 | [`.github/workflows/release.yml`](https://github.com/drmowinckels/cairn/blob/main/.github/workflows/release.yml)    |
| Bundle config            | [`src-tauri/tauri.conf.json`](https://github.com/drmowinckels/cairn/blob/main/src-tauri/tauri.conf.json) → `bundle` |
| Entitlements             | [`src-tauri/entitlements.plist`](https://github.com/drmowinckels/cairn/blob/main/src-tauri/entitlements.plist)      |
| Release notes source     | [`CHANGELOG.md`](https://github.com/drmowinckels/cairn/blob/main/CHANGELOG.md) (topmost `##` section)               |
| Operator steps + secrets | [`RELEASING.md`](https://github.com/drmowinckels/cairn/blob/main/RELEASING.md)                                      |
