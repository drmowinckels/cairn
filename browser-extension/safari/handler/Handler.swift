// Cairn Safari Web Extension handler — the IO half of the bridge (#37).
//
// NOT standalone-compilable on its own: the build step
// (browser-extension/safari/build-wrapper.sh) concatenates BridgeCore.swift
// + this file into the generated extension target's
// `SafariWebExtensionHandler.swift`. That keeps the gate logic (BridgeCore)
// the SAME source `run-tests.sh` tests — there is no second copy to drift.
// This file adds ONLY the NSExtension entry point and the App Group socket
// write; every drop/keep decision still lives in BridgeCore.
//
// Flow: Safari delivers the `browser.runtime.sendNativeMessage` payload as a
// dictionary; we re-serialize it to JSON and feed `BridgeCore.process` (the
// single parsing + gating authority, identical to the Rust host). On
// `.emit` we connect to the App Group socket and write one line; a `.drop`
// is silently discarded. A sandboxed handler cannot reach a socket OUTSIDE
// its container (proven by the spike, #249) — which is why the socket lives
// in the App Group container (#250) and this target carries the
// `application-groups` entitlement.

import Darwin
import Foundation
import SafariServices

/// The App Group whose container holds the IPC socket. MUST match
/// `APP_GROUP_ID` in src-tauri (`plugins::browser`) and `MACOS_APP_GROUP_ID`
/// in the native host — the socket move (#250) put it here.
private let cairnAppGroupID = "group.io.drmowinckels.cairn"

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        // The extension is fire-and-forget: always complete the request,
        // whatever the gates decide.
        defer { context.completeRequest(returningItems: [], completionHandler: nil) }

        guard let message = extractMessage(from: context),
            let data = try? JSONSerialization.data(withJSONObject: message)
        else { return }

        switch BridgeCore.process(data) {
        case .drop:
            return
        case let .emit(domain, incognito, focused, browserLabel):
            let line = BridgeCore.encode(
                domain: domain, incognito: incognito, focused: focused, browserLabel: browserLabel)
            if !line.isEmpty {
                writeLineToSocket(line + "\n")
            }
        }
    }

    /// Pull the `sendNativeMessage` payload out of the extension request.
    private func extractMessage(from context: NSExtensionContext) -> Any? {
        let item = context.inputItems.first as? NSExtensionItem
        if #available(macOS 11.0, *) {
            return item?.userInfo?[SFExtensionMessageKey]
        }
        return item?.userInfo?["message"]
    }

    /// Resolve the App Group socket and write one line. Best-effort and
    /// fire-and-forget: if Cairn isn't running (no listener) the connect
    /// fails and we drop silently — exactly like the Chrome/Firefox host.
    private func writeLineToSocket(_ line: String) {
        guard
            let container = FileManager.default
                .containerURL(forSecurityApplicationGroupIdentifier: cairnAppGroupID)
        else { return }
        let path = container.appendingPathComponent("ipc/sock").path

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        if fd < 0 { return }
        defer { close(fd) }

        // Match the Rust host's defensive 1s timeout (it sets a write
        // timeout for the same reason): a wedged Cairn that is bound but
        // not reading must not stall the extension thread until the
        // app-extension watchdog kills us. `connect` to a listening UDS
        // returns promptly, so the send timeout is the load-bearing one.
        var timeout = timeval(tv_sec: 1, tv_usec: 0)
        let tvLen = socklen_t(MemoryLayout<timeval>.size)
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, tvLen)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, tvLen)

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let sunPathLen = MemoryLayout.size(ofValue: addr.sun_path)
        if path.utf8.count >= sunPathLen { return }
        _ = path.withCString { cstr in
            withUnsafeMutablePointer(to: &addr.sun_path) { raw in
                raw.withMemoryRebound(to: CChar.self, capacity: sunPathLen) { dst in
                    strncpy(dst, cstr, sunPathLen - 1)
                }
            }
        }
        let connected = withUnsafePointer(to: &addr) { aptr in
            aptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                connect(fd, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        if connected != 0 { return }
        _ = line.withCString { send(fd, $0, strlen($0), 0) }
    }
}
