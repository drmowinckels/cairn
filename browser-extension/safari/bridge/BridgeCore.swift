// Cairn Safari bridge — pure gate logic. NO IO, NO socket, NO Xcode.
//
// Safari (unlike Chrome/Firefox) can't use the Rust Native Messaging host
// (`browser-extension/native-host`): a Safari Web Extension's native side
// is a `SafariWebExtensionHandler` compiled into the containing macOS app
// and run under the App Sandbox. So the privacy gates the Rust host
// enforces have to be re-implemented in Swift — and kept byte-for-byte in
// lockstep, or the Safari path could leak what the Chrome/Firefox path
// drops.
//
// This file is that re-implementation, factored as a pure function so it
// is unit-testable with `swiftc` alone (no full Xcode, no XCTest). The
// eventual `SafariWebExtensionHandler` (#37 slice 2) calls `process(_:)`
// and writes an `.emit` line to the App Group socket
// (`~/Library/Group Containers/group.io.drmowinckels.cairn/ipc/sock`,
// #250); a `.drop` is silently discarded.
//
// It mirrors the Rust host's `project_inbound` + the serde `Inbound`/
// `Outbound` shapes (`browser-extension/native-host/src/main.rs`). The
// shared `test-vectors.json` is asserted on BOTH sides so the two can't
// drift. Parity details that matter:
//   - `browserLabel` length is a UTF-8 BYTE count (Rust `String::len`),
//     not a grapheme count — hence `utf8.count`.
//   - "control char" is Unicode general category Cc only (Rust
//     `char::is_control`), NOT Cf — hence `generalCategory == .control`.
//   - Unknown fields (`path`, `title`, …) are dropped by decoding into a
//     fixed shape, exactly as serde drops unknown fields.
//   - The bridge mirrors the HOST: it FORWARDS `incognito: true`. The
//     in-app collector (`plugins::browser::parser`) is what drops
//     incognito before the rules engine — not this bridge.

import Foundation

/// Why the bridge refused a frame. Raw values are the language-neutral
/// tokens used in `test-vectors.json` so the Rust and Swift assertions
/// compare against the same strings.
public enum DropReason: String, Equatable {
    /// Not JSON, or missing/!String `domain`, or a present field with the
    /// wrong type — anything serde / `JSONDecoder` rejects.
    case malformed
    /// `domain == "" && focused` — indistinguishable from the legitimate
    /// `WINDOW_ID_NONE` heartbeat (which carries `focused: false`), so a
    /// forged "focused on the empty domain" frame is dropped.
    case emptyFocusedDomain = "empty_focused_domain"
    /// `browserLabel` longer than 64 UTF-8 bytes or carrying a control
    /// char (which would break the newline framing on the socket).
    case badBrowserLabel = "bad_browser_label"
    /// Input exceeds the 64 KiB frame cap.
    case tooLarge = "too_large"
}

/// The result of running the gates over one inbound frame.
public enum Outcome: Equatable {
    /// Forward exactly these four allowlisted fields to the socket.
    case emit(domain: String, incognito: Bool, focused: Bool, browserLabel: String?)
    /// Drop the frame for the given reason; nothing reaches the socket.
    case drop(DropReason)
}

public enum BridgeCore {
    /// Maximum inbound frame size. Mirrors the Rust host's
    /// `MAX_INBOUND_BYTES` and the socket's `MAX_LINE_BYTES` (64 KiB).
    public static let maxBytes = 64 * 1024

    /// The allowlisted inbound shape. `Decodable` ignores unknown keys, so
    /// `path` / `title` / anything else never survives — the field
    /// allowlist is enforced by the type, not by hand.
    private struct Inbound: Decodable {
        let domain: String
        let incognito: Bool?
        let focused: Bool?
        let browserLabel: String?
    }

    /// Run every gate over a raw inbound frame.
    public static func process(_ raw: Data) -> Outcome {
        if raw.count > maxBytes {
            return .drop(.tooLarge)
        }
        guard let msg = try? JSONDecoder().decode(Inbound.self, from: raw) else {
            return .drop(.malformed)
        }
        // serde defaults: missing `incognito` is false, missing `focused`
        // is true.
        let incognito = msg.incognito ?? false
        let focused = msg.focused ?? true

        if msg.domain.isEmpty && focused {
            return .drop(.emptyFocusedDomain)
        }
        if let label = msg.browserLabel, !isAcceptableLabel(label) {
            return .drop(.badBrowserLabel)
        }
        return .emit(
            domain: msg.domain,
            incognito: incognito,
            focused: focused,
            browserLabel: msg.browserLabel
        )
    }

    /// Convenience for a `String` frame (UTF-8 encoded before the cap
    /// check, so the byte count matches the socket's view).
    public static func process(_ raw: String) -> Outcome {
        process(Data(raw.utf8))
    }

    /// A `browserLabel` is acceptable when it is at most 64 UTF-8 bytes
    /// and free of Cc control chars. Matches the Rust host's
    /// `label.len() > 64 || label.chars().any(|c| c.is_control())`.
    static func isAcceptableLabel(_ label: String) -> Bool {
        if label.utf8.count > 64 {
            return false
        }
        return !label.unicodeScalars.contains { $0.properties.generalCategory == .control }
    }
}
