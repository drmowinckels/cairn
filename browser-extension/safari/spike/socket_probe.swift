// THROWAWAY SPIKE ARTIFACT — not shipped, not part of the wrapper app.
//
// Minimal probe for the single biggest unknown blocking #37's Safari
// slice (see ../../../docs/future/safari-extension.md, "Risks"): can a
// process running under the macOS **App Sandbox** `connect(2)` to the
// main Cairn IPC socket, which lives OUTSIDE any sandbox container at
// `~/Library/Application Support/io.drmowinckels.cairn/ipc/sock`?
//
// Safari Web Extension handlers (`SafariWebExtensionHandler`) always run
// as sandboxed app extensions. The load-bearing question is the App
// Sandbox *filesystem policy* for an out-of-container AF_UNIX path — and
// that policy is identical whether the sandboxed Mach-O is a real
// `.appex` or a CLI tool ad-hoc-signed with `com.apple.security.app-sandbox`.
// So this tool, signed with that one entitlement, reproduces the exact
// constraint the real handler would hit, without needing full Xcode or
// Safari's GUI enable flow.
//
// Usage:
//   socket_probe connect <absolute-socket-path>
//   socket_probe diag                 -- print sandbox-activation evidence
//
// Exit codes encode the outcome so the harness can branch on them:
//   0   connected + wrote one line          (path reachable)
//   20  connect() failed                    (stdout: errno + name)
//   21  write failed after connect
//   2   usage error
//   10  socket() syscall failed

import Foundation
#if canImport(Darwin)
import Darwin
#endif

func fail(_ code: Int32, _ msg: String) -> Never {
    FileHandle.standardError.write(Data((msg + "\n").utf8))
    exit(code)
}

let args = CommandLine.arguments

// `diag` exists only to PROVE the sandbox is actually active for this
// run. App Sandbox rewrites HOME to the per-bundle container
// (`~/Library/Containers/<id>/Data`); an unsandboxed run reports the
// real home. The harness compares the two so a "connect blocked" result
// can't be mistaken for the sandbox silently failing to engage.
if args.count == 2, args[1] == "diag" {
    let home = NSHomeDirectory()
    let envHome = String(cString: getenv("HOME") ?? strdup("(unset)"))
    let sandboxed = home.contains("/Library/Containers/")
    print("NSHomeDirectory=\(home)")
    print("HOME=\(envHome)")
    print("sandboxed=\(sandboxed)")
    exit(0)
}

guard args.count == 3, args[1] == "connect" else {
    fail(2, "usage: socket_probe connect <absolute-socket-path> | socket_probe diag")
}
let path = args[2]

let fd = socket(AF_UNIX, SOCK_STREAM, 0)
if fd < 0 {
    let e = errno
    fail(10, "SOCKET_FAIL errno=\(e) (\(String(cString: strerror(e))))")
}
defer { close(fd) }

var addr = sockaddr_un()
addr.sun_family = sa_family_t(AF_UNIX)
let sunPathLen = MemoryLayout.size(ofValue: addr.sun_path)
if path.utf8.count >= sunPathLen {
    fail(2, "path too long for sun_path (\(path.utf8.count) >= \(sunPathLen))")
}
path.withCString { cstr in
    withUnsafeMutablePointer(to: &addr.sun_path) { raw in
        raw.withMemoryRebound(to: CChar.self, capacity: sunPathLen) { dst in
            _ = strncpy(dst, cstr, sunPathLen - 1)
        }
    }
}

let connectRC = withUnsafePointer(to: &addr) { aptr in
    aptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
        connect(fd, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
    }
}
if connectRC != 0 {
    let e = errno
    print("CONNECT_FAIL errno=\(e) (\(String(cString: strerror(e)))) path=\(path)")
    exit(20)
}

// One well-formed line matching the Rust host's wire shape, so a real
// listener (or `nc -lU`) sees exactly what the bridge would send.
let line = "{\"domain\":\"spike.example\",\"focused\":true,\"incognito\":false}\n"
let bytes = Array(line.utf8)
let written = bytes.withUnsafeBytes { send(fd, $0.baseAddress, $0.count, 0) }
if written < 0 {
    let e = errno
    print("WRITE_FAIL errno=\(e) (\(String(cString: strerror(e)))) path=\(path)")
    exit(21)
}
print("OK connected + wrote \(written) bytes to \(path)")
exit(0)
