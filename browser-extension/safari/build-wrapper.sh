#!/usr/bin/env bash
# Generate the Safari Web Extension wrapper in CI (no committed Xcode
# project, #37), inject Cairn's handler + BridgeCore + the App Group
# entitlement, and (by default) run an UNSIGNED smoke build that proves the
# wrapper + injected Swift compile. Signing + notarization are release.yml's
# job — they need the Apple Team ID and a provisioning grant for the group.
#
# Usage: build-wrapper.sh <output-dir>      e.g. "$RUNNER_TEMP/safari"
# Env:   SMOKE_BUILD=0 to generate + inject only (skip xcodebuild).
#
# Requires full Xcode (macOS runner): `safari-web-extension-converter`,
# `xcodebuild`, `PlistBuddy`.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
out="${1:?usage: build-wrapper.sh <output-dir>}"
group="group.io.drmowinckels.cairn"

rm -rf "$out"
xcrun safari-web-extension-converter "$repo/browser-extension/src" \
  --project-location "$out" \
  --app-name Cairn \
  --bundle-identifier io.drmowinckels.cairn \
  --macos-only --no-open --no-prompt --force --copy-resources

ext="$out/Cairn/Cairn Extension"
proj="$out/Cairn/Cairn.xcodeproj"

# Inject the handler: BridgeCore (the SAME source run-tests.sh proves) + the
# IO glue, concatenated into the target's existing handler file. Overwriting
# a file already in the target avoids editing project.pbxproj.
cat \
  "$repo/browser-extension/safari/bridge/BridgeCore.swift" \
  "$repo/browser-extension/safari/handler/Handler.swift" \
  >"$ext/SafariWebExtensionHandler.swift"

# Add the App Group entitlement to the app + extension targets so the
# sandboxed handler can reach the socket in the shared container (#250).
add_group() {
  local plist="$1"
  /usr/libexec/PlistBuddy -c "Delete :com.apple.security.application-groups" "$plist" 2>/dev/null || true
  /usr/libexec/PlistBuddy \
    -c "Add :com.apple.security.application-groups array" \
    -c "Add :com.apple.security.application-groups:0 string $group" \
    "$plist"
}
add_group "$ext/Cairn_Extension.entitlements"
add_group "$out/Cairn/Cairn/Cairn.entitlements"

if [[ "${SMOKE_BUILD:-1}" == "1" ]]; then
  # Unsigned: CODE_SIGNING_ALLOWED=NO skips entitlement/provisioning checks,
  # so the app-group entitlement needs no Team ID to compile.
  xcodebuild build \
    -project "$proj" \
    -scheme Cairn \
    -configuration Debug \
    -destination 'platform=macOS' \
    CODE_SIGNING_ALLOWED=NO \
    CODE_SIGNING_REQUIRED=NO \
    CODE_SIGN_IDENTITY=""
fi
