# Releasing Cairn

This walks through cutting a beta release. The pipeline is defined in
[`.github/workflows/release.yml`](.github/workflows/release.yml); it
builds, tests, signs, and uploads bundles for macOS, Windows, and Linux,
then attaches them to a **draft** GitHub Release you approve by hand.

> The release is always created as a **draft pre-release**. Nothing is
> published to users until you click "Publish" in the GitHub UI.

## One-time setup

### Repository secrets

Add these under **Settings → Secrets and variables → Actions**. The
macOS signing secrets are optional — without them the pipeline still
runs and produces an _unsigned_ macOS bundle (useful for dry runs), but
Gatekeeper will warn end users, so they're required for a real release.

| Secret                       | What it is                                                                                                                                   | Required for       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `APPLE_CERTIFICATE`          | Base64 of your **Developer ID Application** cert exported as `.p12`. `base64 -i cert.p12 \| pbcopy`                                          | macOS signing      |
| `APPLE_CERTIFICATE_PASSWORD` | The password you set when exporting the `.p12`                                                                                               | macOS signing      |
| `APPLE_SIGNING_IDENTITY`     | The identity string, e.g. `Developer ID Application: Your Name (TEAMID)`                                                                     | macOS signing      |
| `APPLE_ID`                   | The Apple ID email of the Developer account                                                                                                  | macOS notarization |
| `APPLE_PASSWORD`             | An **app-specific password** for that Apple ID (appleid.apple.com → Sign-In & Security → App-Specific Passwords), _not_ the account password | macOS notarization |
| `APPLE_TEAM_ID`              | Your 10-character Apple Developer Team ID                                                                                                    | macOS notarization |

> Notarization auth can alternatively use an App Store Connect API key
> (`APPLE_API_ISSUER` / `APPLE_API_KEY` / `APPLE_API_KEY_PATH`). We use
> the Apple-ID + app-specific-password path above because it needs no
> key file in CI. If you switch, update the `env:` block in
> `release.yml` accordingly.

### Windows code-signing (#43)

The Windows job builds a WiX **MSI** (Start-menu shortcut + uninstaller)
and Authenticode-signs it when these secrets are present. They are
**optional** — without them the MSI still builds, just unsigned (handy
for dry runs), but Windows SmartScreen will warn end users, so a real
release wants them set.

| Secret                         | What it is                                                                              | Required for    |
| ------------------------------ | --------------------------------------------------------------------------------------- | --------------- |
| `WINDOWS_CERTIFICATE`          | Base64 of your code-signing cert exported as `.pfx`. `base64 -i cert.pfx` (no newlines) | Windows signing |
| `WINDOWS_CERTIFICATE_PASSWORD` | The password you set when exporting the `.pfx`                                          | Windows signing |

The job decodes the PFX, imports it into the runner's certificate store,
reads its thumbprint, and writes `src-tauri/tauri.windows.conf.json` —
which Tauri auto-merges (RFC 7396) so the WiX bundler signs the MSI. That
file is generated in CI and git-ignored; the signing identity never
touches the repo.

> **SmartScreen.** A standard OV certificate signs the binary but earns
> SmartScreen reputation only over time/downloads; an **EV** certificate
> clears SmartScreen immediately. A **self-signed** cert (below) is fine
> to prove the signing path end-to-end but gives users an
> _untrusted-publisher_ prompt — for public betas, unsigned or a real
> OV/EV cert are the realistic choices.

#### Generating a self-signed cert (to test the signing path)

On a Windows machine / runner (PowerShell):

```powershell
$cert = New-SelfSignedCertificate -Type CodeSigning `
  -Subject "CN=Cairn (self-signed test)" `
  -CertStoreLocation Cert:\CurrentUser\My
$pwd = ConvertTo-SecureString -String "<choose-a-password>" -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath cairn-test.pfx -Password $pwd
# Then: base64 the .pfx into WINDOWS_CERTIFICATE, password into WINDOWS_CERTIFICATE_PASSWORD
[Convert]::ToBase64String([IO.File]::ReadAllBytes("cairn-test.pfx")) | Set-Clipboard
```

### Updater signing key (#45)

The opt-in update checker verifies the release manifest against a public
key bundled in `tauri.conf.json` (`plugins.updater.pubkey`). The matching
**private key** signs the updater artifacts and must live in CI:

| Secret                               | What it is                                                        | Required for            |
| ------------------------------------ | ----------------------------------------------------------------- | ----------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | Contents of the minisign private key from `tauri signer generate` | Signed update artifacts |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password set when generating the key (empty string if none)   | Signed update artifacts |

Generate the pair once with `npm run tauri signer generate -- -w cairn-updater.key`
(keep the `.key` private — **never commit it**; the `.pub` value is what
goes in `tauri.conf.json`). The current pair's public key is already in
the config.

> **Not wired into the pipeline yet.** Generating the signed `latest.json`
>
> - artifacts in `release.yml` (and setting `bundle.createUpdaterArtifacts`)
>   lands with the packaging epics (#43 / #44). Until then the checker is
>   live in-app but has no published manifest to find, so it simply reports
>   "up to date". Add the two secrets above before enabling artifact
>   signing.

### Getting the Developer ID Application certificate

1. In the [Apple Developer](https://developer.apple.com/account/resources/certificates)
   portal, create a **Developer ID Application** certificate (this is
   the _distribute outside the App Store_ cert, not "Mac App
   Distribution").
2. Download it and double-click to import into **Keychain Access**.
3. In Keychain, right-click the cert → **Export** → `.p12`, set a
   password (this becomes `APPLE_CERTIFICATE_PASSWORD`).
4. `base64 -i Certificates.p12 | pbcopy` and paste into the
   `APPLE_CERTIFICATE` secret.
5. Read the identity name with
   `security find-identity -v -p codesigning` and copy the
   `Developer ID Application: …` string into `APPLE_SIGNING_IDENTITY`.

## Cutting a release

1. **Bump the version.** Update `version` in
   [`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json) and
   `package.json` to match the tag (e.g. `0.1.0`).
2. **Write the notes.** Add a new top section to
   [`CHANGELOG.md`](CHANGELOG.md) — the pipeline auto-extracts the
   topmost `##` section as the release body.
3. **Commit on `main`** via PR, as usual.
4. **Tag and push:**

   ```bash
   git tag v0.1.0-beta
   git push origin v0.1.0-beta
   ```

   (Or run the workflow manually: **Actions → Release → Run workflow**,
   passing an existing tag.)

5. **Watch the run.** Three matrix jobs build in parallel. The macOS job
   signs + notarizes + staples; notarization can take several minutes
   while Apple processes the submission.
6. **Review the draft Release.** When all jobs finish, a draft
   pre-release appears under **Releases** with the `.dmg`, the Windows
   installer, and the Linux `.deb` + AppImage attached. Download and
   smoke-test at least the macOS `.dmg` on a clean machine
   (`spctl -a -vvv /Applications/Cairn.app` should report
   `source=Notarized Developer ID`).
7. **Publish** from the GitHub UI when satisfied.

## Verifying a signed + notarized macOS build

```bash
# Signature + hardened runtime
codesign -dv --verbose=4 /Applications/Cairn.app

# Gatekeeper acceptance (the real test)
spctl --assess --type execute -vvv /Applications/Cairn.app

# Staple was applied to the app and dmg
stapler validate /Applications/Cairn.app
stapler validate Cairn_0.1.0_universal.dmg
```

## Verifying the Linux bundles (#44)

The Linux job emits a `.deb` and an AppImage. There is no signature to
check (integrity is via the release checksums), so verification is an
install + launch round-trip on the supported distros:

```bash
# Debian 12 / Ubuntu 22.04+ — install, launch, then remove
sudo apt install ./Cairn_0.1.0_amd64.deb
cairn            # tray icon appears; popover opens
sudo apt remove cairn

# AppImage — Ubuntu 22.04 LTS and Fedora 39+ (no install step)
chmod +x Cairn_0.1.0_amd64.AppImage
./Cairn_0.1.0_amd64.AppImage
```

> The `.deb` runtime dependencies live in `tauri.conf.json`
> (`bundle.linux.deb.depends`); if a fresh install complains about a
> missing `libwebkit2gtk` / `libayatana-appindicator`, reconcile that
> list. `rpm` is intentionally not shipped — AppImage covers Fedora.

## Troubleshooting

- **`The binary is not signed with a valid Developer ID`** — the
  `APPLE_SIGNING_IDENTITY` doesn't match the imported cert, or the cert
  is "Mac Developer" rather than "Developer ID Application".
- **Notarization rejected** — download the log with
  `xcrun notarytool log <submission-id> --apple-id … --team-id …`. The
  usual cause is a nested binary missing the hardened-runtime flag or an
  entitlement; check `src-tauri/entitlements.plist`.
- **WKWebView crashes on launch only in the signed build** — hardened
  runtime may need `com.apple.security.cs.allow-jit`; add it to the
  entitlements file and re-release.

See [`docs/architecture/release.md`](docs/architecture/release.md) for
the certificate-rotation runbook and the deeper signing rationale.
