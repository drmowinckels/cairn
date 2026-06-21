#!/usr/bin/env bash
# THROWAWAY SPIKE HARNESS for #37 — see SPIKE.md.
#
# Answers one question with evidence: can a process under the macOS App
# Sandbox connect(2) to Cairn's IPC socket, which lives OUTSIDE any
# sandbox container? We A/B the SAME probe binary — once unsandboxed
# (control), once ad-hoc-signed with `com.apple.security.app-sandbox`
# (treatment) — against a stand-in listener at the same class of path as
# the real socket. The only variable between the two runs is the
# entitlement.
#
# Requires only the Command Line Tools (swiftc + codesign) and python3 —
# NOT full Xcode. Re-runnable; cleans up after itself. Touches a
# `-spike`-suffixed app-support dir, never the real Cairn socket.
set -u

here="$(cd "$(dirname "$0")" && pwd)"
build="$here/build"
rm -rf "$build"
mkdir -p "$build"

# Stand-in for the real socket. Same policy class as Cairn's path
# (arbitrary dir under ~/Library/Application Support, i.e. outside every
# sandbox container) but a distinct `-spike` bundle dir so we never
# clobber a running Cairn.
appsup="$HOME/Library/Application Support/io.drmowinckels.cairn-spike/ipc"
out_sock="$appsup/sock"
out_log="$build/listener-appsupport.log"
# Trailing X's only — BSD mktemp won't substitute X's that aren't at the
# end of the template, so a `.sock` suffix would leave the name literal.
tmp_sock="$(mktemp -u /tmp/cairn-spike.XXXXXX)"
tmp_log="$build/listener-tmp.log"

cleanup() {
  [[ -n "${L1:-}" ]] && kill "$L1" 2>/dev/null
  [[ -n "${L2:-}" ]] && kill "$L2" 2>/dev/null
  rm -f "$out_sock" "$tmp_sock"
  rmdir "$appsup" 2>/dev/null
  rmdir "$(dirname "$appsup")" 2>/dev/null
}
trap cleanup EXIT

wait_for_sock() {
  for _ in $(seq 1 100); do
    [[ -S "$1" ]] && return 0
    sleep 0.02
  done
  return 1
}

echo "== 1. build probe (embedding Info.plist bundle id) =="
swiftc -O "$here/socket_probe.swift" -o "$build/socket_probe" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$here/Info.plist" ||
  {
    echo "BUILD FAILED"
    exit 1
  }
cp "$build/socket_probe" "$build/probe_plain"
cp "$build/socket_probe" "$build/probe_sandboxed"

echo "== 2. sign: control (no entitlements) vs treatment (app-sandbox) =="
codesign --force --sign - "$build/probe_plain" 2>&1
codesign --force --sign - --entitlements "$here/sandbox.entitlements" "$build/probe_sandboxed" 2>&1
echo "-- embedded entitlements on the sandboxed binary --"
codesign -d --entitlements - "$build/probe_sandboxed" 2>&1 | sed 's/^/   /'

echo "== 3. start stand-in listeners =="
python3 "$here/listener.py" "$out_sock" "$out_log" &
L1=$!
python3 "$here/listener.py" "$tmp_sock" "$tmp_log" &
L2=$!
wait_for_sock "$out_sock" || {
  echo "listener (app-support) never bound"
  exit 1
}
wait_for_sock "$tmp_sock" || {
  echo "listener (tmp) never bound"
  exit 1
}
echo "   app-support listener: $out_sock"
echo "   tmp listener:         $tmp_sock"

run() { # label binary args...
  local label="$1"
  shift
  local bin="$1"
  shift
  echo "   [$label] $("$bin" "$@" 2>&1); exit=$?"
}

echo "== 4. CONTROL — unsandboxed =="
echo -n "   diag: "
"$build/probe_plain" diag 2>&1 | tr '\n' ' '
echo
# The whole experiment hinges on the control reaching the socket: if the
# unsandboxed probe can't connect, the treatment's EPERM proves nothing
# (it could be a bad path / unbound listener, not the sandbox). Gate on it.
ctl_out="$("$build/probe_plain" connect "$out_sock" 2>&1)"
ctl_rc=$?
echo "   [connect app-support] $ctl_out; exit=$ctl_rc"
if [[ $ctl_rc -ne 0 ]]; then
  echo "EXPERIMENT INVALID: the unsandboxed control could not reach the socket," >&2
  echo "so a sandboxed EPERM would be uninterpretable. Aborting." >&2
  exit 1
fi

echo "== 5. TREATMENT — App Sandbox =="
echo "   diag (proves the sandbox engaged — HOME should be a Containers path):"
"$build/probe_sandboxed" diag 2>&1 | sed 's/^/      /'
run "connect app-support" "$build/probe_sandboxed" connect "$out_sock"
run "connect /tmp" "$build/probe_sandboxed" connect "$tmp_sock"

echo "== 6. what the listeners received =="
echo "   app-support: $(wc -l <"$out_log" | tr -d ' ') line(s)"
sed 's/^/      /' "$out_log"
echo "   tmp:         $(wc -l <"$tmp_log" | tr -d ' ') line(s)"
sed 's/^/      /' "$tmp_log"

echo "== done =="
