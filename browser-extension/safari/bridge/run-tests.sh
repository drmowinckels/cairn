#!/usr/bin/env bash
# Compile + run the Swift bridge gate-parity check with swiftc only — no
# full Xcode, no XCTest (neither is available under the Command Line
# Tools). Mirrors the Rust side, which asserts the SAME test-vectors.json
# against the native host's `project_inbound`. Used locally and in CI
# (macos runner). See BridgeCore.swift.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

swiftc -O \
  "$here/BridgeCore.swift" \
  "$here/BridgeTests.swift" \
  -o "$out/bridge-tests"

"$out/bridge-tests" "$here/test-vectors.json"
