// swiftc-runnable parity check for BridgeCore (no XCTest — XCTest ships
// only with full Xcode, this runs under the Command Line Tools too).
// Loads the shared `test-vectors.json`, runs `BridgeCore.process` over
// each case, and asserts the Outcome matches. Exits non-zero on any
// mismatch so `run-tests.sh` / CI fail loudly. The Rust side asserts the
// SAME vector against the native host's `project_inbound`.

import Foundation

private struct Vector: Decodable {
    let maxBytes: Int
    let cases: [Case]
}

private struct Case: Decodable {
    let name: String
    let input: String
    let expect: Expect
}

private struct Expect: Decodable {
    let kind: String
    let reason: String?
    let domain: String?
    let incognito: Bool?
    let focused: Bool?
    let browserLabel: String?
}

@main
enum BridgeTests {
    static func main() {
        let path =
            CommandLine.arguments.count > 1
            ? CommandLine.arguments[1]
            : defaultVectorPath()

        guard let data = FileManager.default.contents(atPath: path) else {
            fail("cannot read test vectors at \(path)")
        }
        let vector: Vector
        do {
            vector = try JSONDecoder().decode(Vector.self, from: data)
        } catch {
            fail("cannot parse \(path): \(error)")
        }

        if vector.maxBytes != BridgeCore.maxBytes {
            fail("maxBytes drift: vector \(vector.maxBytes) vs BridgeCore \(BridgeCore.maxBytes)")
        }

        var failures = 0
        for c in vector.cases {
            let actual = BridgeCore.process(c.input)
            if let mismatch = check(actual, against: c.expect) {
                failures += 1
                FileHandle.standardError.write(Data("FAIL  \(c.name): \(mismatch)\n".utf8))
            } else {
                print("ok    \(c.name)")
            }
        }

        // The 64 KiB cap is too bulky to carry as a JSON literal, so
        // exercise it directly (the Rust side has its own oversize test).
        let oversize = String(repeating: "a", count: BridgeCore.maxBytes + 1)
        if BridgeCore.process(oversize) == .drop(.tooLarge) {
            print("ok    oversize frame (>maxBytes) drops as tooLarge")
        } else {
            failures += 1
            FileHandle.standardError.write(Data("FAIL  oversize frame not dropped as tooLarge\n".utf8))
        }

        // encode() must round-trip back through process() to the same
        // emit — the handler writes encode()'s output to the socket, so it
        // has to survive re-parsing by the receiver. Covers a label and the
        // omitted-label case.
        let roundTrips: [(String, Bool, Bool, String?)] = [
            ("github.com", false, true, "Chrome 120"),
            ("x.com", true, false, nil),
        ]
        for (domain, incognito, focused, label) in roundTrips {
            let line = BridgeCore.encode(
                domain: domain, incognito: incognito, focused: focused, browserLabel: label)
            if BridgeCore.process(line) == .emit(
                domain: domain, incognito: incognito, focused: focused, browserLabel: label)
            {
                print("ok    encode round-trips for \(domain)")
            } else {
                failures += 1
                FileHandle.standardError.write(
                    Data("FAIL  encode round-trip for \(domain)\n".utf8))
            }
        }

        let total = vector.cases.count + 1 + roundTrips.count
        if failures == 0 {
            print("\nBridgeCore parity: \(total)/\(total) checks pass (maxBytes=\(vector.maxBytes))")
            exit(0)
        }
        FileHandle.standardError.write(Data("\n\(failures)/\(total) case(s) FAILED\n".utf8))
        exit(1)
    }

    /// Returns `nil` when the outcome matches the expectation, or a
    /// human-readable reason for the mismatch.
    private static func check(_ actual: Outcome, against expect: Expect) -> String? {
        switch (expect.kind, actual) {
        case ("drop", .drop(let reason)):
            return reason.rawValue == expect.reason
                ? nil : "expected drop \(expect.reason ?? "nil"), got drop \(reason.rawValue)"
        case ("emit", .emit(let domain, let incognito, let focused, let label)):
            if domain != expect.domain { return "domain \(domain) != \(expect.domain ?? "nil")" }
            if incognito != (expect.incognito ?? false) { return "incognito \(incognito)" }
            if focused != (expect.focused ?? true) { return "focused \(focused)" }
            if label != expect.browserLabel {
                return "browserLabel \(label ?? "nil") != \(expect.browserLabel ?? "nil")"
            }
            return nil
        default:
            return "expected \(expect.kind), got \(actual)"
        }
    }

    /// `test-vectors.json` sits next to this source file.
    private static func defaultVectorPath() -> String {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("test-vectors.json")
            .path
    }

    private static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data("bridge-tests: \(message)\n".utf8))
        exit(2)
    }
}
