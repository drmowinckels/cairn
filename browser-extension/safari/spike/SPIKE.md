# Spike: can a sandboxed Safari handler reach Cairn's IPC socket? (#37)

**Status: complete. Verdict: BLOCKED — option 1 cannot ship as written.**

This is slice 1 of the Safari Web Extension work
([`docs/future/safari-extension.md`](../../../docs/future/safari-extension.md)).
It is a **throwaway** experiment — none of the code here ships. It exists
only to answer the one question the slice plan gates everything else on.

## The question

A Safari Web Extension's native side is a `SafariWebExtensionHandler`
compiled **into the containing app** and run as a macOS **app extension**.
App extensions always run under the **App Sandbox**. The doc's recommended
"option 1" has that Swift handler open Cairn's IPC socket directly and
write the same newline-delimited JSON the Rust native host writes.

That socket lives **outside any sandbox container**:

```
~/Library/Application Support/io.drmowinckels.cairn/ipc/sock
```

> Risk (from the scope doc): _"App-extension sandbox may restrict opening
> an arbitrary Unix socket outside the app group container. Validate early
> … this is the single biggest unknown — spike it before committing to the
> slice plan."_

So: **does the App Sandbox permit `connect(2)` to an AF_UNIX socket at a
path outside the process's container?**

## Method — why a signed CLI tool is a faithful proxy

We do **not** need full Xcode or Safari's GUI enable flow to answer this.
The reachability of an out-of-container AF*UNIX socket is decided by the
App Sandbox's **filesystem policy**, which keys off the
`com.apple.security.app-sandbox` entitlement — \_not* off whether the
sandboxed Mach-O is a real `.appex` or a plain executable. So we:

1. Compile a tiny Swift probe ([`socket_probe.swift`](socket_probe.swift))
   that `connect()`s to a socket path and writes one well-formed line.
   An [`Info.plist`](Info.plist) is embedded in `__TEXT,__info_plist` so
   the ad-hoc-signed tool has a `CFBundleIdentifier` — without one,
   `secinit` can't associate a container and sandbox activation is
   unreliable.
2. Ad-hoc-sign two copies: one **without** entitlements (control), one
   **with** only `com.apple.security.app-sandbox`
   ([`sandbox.entitlements`](sandbox.entitlements)) (treatment).
3. Stand up a stand-in listener ([`listener.py`](listener.py)) at the
   **same class of path** as the real socket — a `-spike`-suffixed dir
   under `~/Library/Application Support/` (outside every container) — so
   the only variable between the two runs is the entitlement.
4. **Prove the sandbox actually engaged.** The probe's `diag` subcommand
   prints `NSHomeDirectory()`; under App Sandbox the kernel rewrites HOME
   to `~/Library/Containers/<bundle-id>/Data`. If the treatment run still
   showed the real home, a "blocked" result would be meaningless — so we
   assert the rewrite happened.

Reproduce with **CLT + python3 only** (no Xcode):

```bash
bash browser-extension/safari/spike/run-spike.sh
```

## Evidence

Verbatim output of `run-spike.sh` on macOS 26 (Apple Silicon, Command
Line Tools, Swift 6.3.1):

```
== 2. sign: control (no entitlements) vs treatment (app-sandbox) ==
-- embedded entitlements on the sandboxed binary --
   [Key] com.apple.security.app-sandbox
   	[Value]
   		[Bool] true

== 4. CONTROL — unsandboxed ==
   diag: NSHomeDirectory=/Users/athanasm HOME=/Users/athanasm sandboxed=false
   [connect app-support] OK connected + wrote 60 bytes to …/io.drmowinckels.cairn-spike/ipc/sock; exit=0

== 5. TREATMENT — App Sandbox ==
   diag (proves the sandbox engaged — HOME should be a Containers path):
      NSHomeDirectory=/Users/athanasm/Library/Containers/io.drmowinckels.cairn.spike.probe/Data
      HOME=/Users/athanasm/Library/Containers/io.drmowinckels.cairn.spike.probe/Data
      sandboxed=true
   [connect app-support] CONNECT_FAIL errno=1 (Operation not permitted) path=…/io.drmowinckels.cairn-spike/ipc/sock; exit=20
   [connect /tmp]        CONNECT_FAIL errno=1 (Operation not permitted) path=/tmp/cairn-spike.nRVTcl; exit=20

== 6. what the listeners received ==
   app-support: 1 line(s)
      RECV b'{"domain":"spike.example","focused":true,"incognito":false}\n'
   tmp:         0 line(s)
```

Reading the three load-bearing facts together:

| Run                      | sandbox active?             | connect to out-of-container socket | listener saw it? |
| ------------------------ | --------------------------- | ---------------------------------- | ---------------- |
| Control (no entitlement) | no                          | **OK** (60 bytes)                  | yes              |
| Treatment (app-sandbox)  | **yes** (HOME → Containers) | **EPERM** (errno 1)                | no               |

The control proves the probe, the path, and the listener all work
end-to-end. The treatment is provably sandboxed (HOME was rewritten) and
the **only** thing changed is the entitlement. The `/tmp` data point shows
the denial isn't specific to `Application Support` — it's _any_
out-of-container path.

The result is deterministic, not a lucky run: the harness aborts unless
the unsandboxed control connects first, so a sandboxed EPERM can only mean
the sandbox, and re-running `run-spike.sh` reproduces it every time.

## Verdict

**The App Sandbox blocks `connect(2)` to the IPC socket at its current
out-of-container path (EPERM).** Option 1 — "the Swift handler opens the
socket directly" — **cannot ship as written.** The spike's headline risk
fired.

Per the slice plan, this **stops the wrapper work**: we do not build slice
2 on the now-falsified assumption that the bare sandbox can reach the
socket.

## Recommendation — the fix is a core change, scope it separately

The Apple-blessed IPC surface shared between a containing app and its app
extension is an **App Group container**. The fix:

1. Add an **App Group** (`group.<TEAMID>.io.drmowinckels.cairn`) entitlement
   to both the main Cairn app and the Safari extension target. (Both must be
   signed with the same Team ID; the group container works across the
   non-sandboxed main app and the sandboxed extension.)
2. **Move — or additionally expose — the IPC socket inside the group
   container**: `~/Library/Group Containers/<group>/ipc/sock`.
   _Not_ a `com.apple.security.temporary-exception.files.*` entitlement
   pointed at the current path: those are Apple-discouraged, App-Store-
   rejected, and brittle (they hard-code an absolute path the sandbox
   would still scope to the real home). The group container is the
   supported mechanism, so we don't pursue the temporary-exception route.
3. Point every socket producer/consumer at the new path:
   - `src-tauri/src/plugins/browser/listener.rs` (`socket_path`, the bind),
   - `browser-extension/native-host/src/main.rs` (`socket_path`, the Chrome/
     Firefox bridge — so it keeps working),
   - the path strings in `docs/PRIVACY.md`, `browser-extension/README.md`,
     and the service-worker comment.

This **touches the main app's socket path and signing**, so it is a core
change that must be designed and approved on its own — not smuggled into a
wrapper PR. It also reopens questions the spike deliberately didn't answer:

- The App Group container path is `0700` per-user by OS construction, but
  the socket's own `0600` + stale-unlink + size-cap gating in
  `listener.rs` must be re-verified at the new path.
- The Chrome/Firefox native host is **not** sandboxed and reaches the
  current path fine; moving the socket must keep that path working (or keep
  both), so the host and the receiver don't diverge.

## Residual unknown (manual tail, not closeable headless)

This probe faithfully reproduces the **filesystem policy** an `.appex`
faces — that's the load-bearing rule and the result is unambiguous. The one
thing it does _not_ exercise is the NSExtension plumbing of a real Safari
handler, and (more importantly) it cannot validate the
`com.apple.security.application-groups` entitlement, which ad-hoc signing
won't grant. So the **app-group fix itself** must be confirmed on a real,
Team-ID-signed build with the extension actually enabled in Safari — the
GUI-driven manual-verification tail, the analogue of the #40/#43/#44 tails.
**#37 stays open** for that.

## Decision gate

```
slice 1 (this spike) ── BLOCKED ──▶ socket-path / app-group core change (new issue)
                                          │
                                          ▼
                              slice 2 (wrapper + Swift bridge)  ← do NOT start until the above lands
                                          │
                                          ▼
                              slice 3 (release integration) → slice 4 (docs)
```
