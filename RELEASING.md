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

Windows (#43) and Linux signing secrets are tracked in their own issues;
the beta ships an unsigned Windows installer for now.

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
