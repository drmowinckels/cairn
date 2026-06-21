# Safari bridge — gate parity core (#37)

Safari is the odd one out. Chrome/Firefox talk to Cairn through the Rust
Native Messaging host (`browser-extension/native-host`), but a Safari Web
Extension's native side is a **Swift `SafariWebExtensionHandler` compiled
into the containing macOS app**, run under the App Sandbox. There is no
standalone host binary Safari will launch — so the Rust host can't be the
bridge, and its privacy gates have to be re-implemented in Swift.

This directory is that re-implementation's **pure core**, written so it can
be built and tested with `swiftc` alone — no full Xcode, no XCTest (neither
is available under the Command Line Tools).

## Files

| File                | Role                                                                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BridgeCore.swift`  | Pure gate logic. Mirrors the Rust host's `project_inbound`: field allowlist, 64 KiB cap, `browserLabel` validation, phantom-empty-domain drop, malformed-frame drop. No IO. |
| `test-vectors.json` | The **shared** gate-parity vector: `input` line → `emit` (the four allowlisted fields) or `drop` (+ a language-neutral reason).                                             |
| `BridgeTests.swift` | `swiftc`-runnable assertion of `BridgeCore` against the vector.                                                                                                             |
| `run-tests.sh`      | Compile + run the Swift side. Used locally and in CI (macОS runner).                                                                                                        |

## Gate parity, enforced

The same `test-vectors.json` is asserted on **both** sides, so the Swift and
Rust gates can't drift:

- **Swift:** `bash run-tests.sh`
- **Rust:** the `gate_parity` test in `browser-extension/native-host`
  (`cargo test --manifest-path browser-extension/native-host/Cargo.toml`)

Parity details that are easy to get wrong and are pinned by the vector:

- `browserLabel` length is a **UTF-8 byte** count (Rust `String::len`), not a
  grapheme count — a 35-character all-`€` label is 105 bytes and is dropped.
- "control char" is Unicode category **Cc only** (Rust `char::is_control`).
- Unknown fields (`path`, `title`, …) never cross — the allowlist is the
  decoded shape, not a hand-rolled filter.
- The bridge **forwards** `incognito: true` (it mirrors the host). Dropping
  incognito happens later, in the in-app collector.

## What this is NOT (yet)

The IO and packaging land with the wrapper (#37 slice 2):

- the `SafariWebExtensionHandler` entry point that calls `BridgeCore.process`
  and writes an `emit` line to the App Group socket
  (`~/Library/Group Containers/group.io.drmowinckels.cairn/ipc/sock`, #250),
- the generated Xcode wrapper app + extension target,
- the `com.apple.security.application-groups` entitlement + signing.
