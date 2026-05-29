#!/usr/bin/env bash
# Cairn browser-extension — native messaging host installer.
#
# Drops the host manifest into each browser's expected location with
# absolute paths substituted in. Run after `cargo build --release` in
# this directory.
#
# Usage:
#   ./install.sh [chrome-extension-id]
#
# If `chrome-extension-id` is omitted the script writes a placeholder
# manifest with `@@CHROME_EXT_ID@@` left in place — useful for local
# development with an unpacked extension whose ID changes on every
# reload. Replace the placeholder by hand the first time you load the
# extension permanently.

set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
HOST_BIN="$HERE/target/release/cairn-browser-host"
CHROME_EXT_ID="${1:-@@CHROME_EXT_ID@@}"

if [ ! -x "$HOST_BIN" ]; then
  echo "error: $HOST_BIN not found. Run 'cargo build --release' first." >&2
  exit 1
fi

# Security review B1 on PR #87: validate the Chromium extension ID
# before interpolating into the manifest. An unsanitised arg can
# inject JSON via `"` or smuggle a wildcard `*` (which Chromium
# accepts in allowed_origins, letting any extension talk to the
# host). The documented Chromium format is exactly 32 lowercase
# a-p characters.
if [ "$CHROME_EXT_ID" != "@@CHROME_EXT_ID@@" ]; then
  if ! printf %s "$CHROME_EXT_ID" | grep -qE '^[a-p]{32}$'; then
    echo "error: invalid Chromium extension ID '$CHROME_EXT_ID'" >&2
    echo "       Expected 32 lowercase a-p chars (e.g. abcdefghijklmnopabcdefghijklmnop)." >&2
    exit 1
  fi
fi

uname_s="$(uname -s)"
case "$uname_s" in
Darwin)
  CHROME_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  CHROMIUM_DIR="$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
  BRAVE_DIR="$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
  EDGE_DIR="$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
  FIREFOX_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
  ;;
Linux)
  CHROME_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
  CHROMIUM_DIR="$HOME/.config/chromium/NativeMessagingHosts"
  BRAVE_DIR="$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
  EDGE_DIR="$HOME/.config/microsoft-edge/NativeMessagingHosts"
  FIREFOX_DIR="$HOME/.mozilla/native-messaging-hosts"
  ;;
*)
  echo "error: unsupported platform '$uname_s'" >&2
  exit 1
  ;;
esac

render_chromium() {
  sed -e "s|@@HOST_PATH@@|$HOST_BIN|g" \
    -e "s|@@CHROME_EXT_ID@@|$CHROME_EXT_ID|g" \
    "$HERE/io.drmowinckels.cairn.json.tmpl"
}

render_firefox() {
  sed -e "s|@@HOST_PATH@@|$HOST_BIN|g" \
    "$HERE/io.drmowinckels.cairn.firefox.json.tmpl"
}

install_into() {
  local dir="$1"
  local rendered="$2"
  # Only register with browsers the user actually has. The parent of
  # the NativeMessagingHosts dir (e.g. `.../Google/Chrome`) exists iff
  # that browser is installed; skipping otherwise avoids littering the
  # user's profile with empty config trees for browsers they don't use.
  local parent
  parent="$(dirname "$dir")"
  if [ ! -d "$parent" ]; then
    echo "skipped: $dir (browser not installed)"
    return 0
  fi
  # Security review R2 on PR #87: refuse to write through a symlink
  # whose target escapes $HOME. A pre-planted symlink at
  # `NativeMessagingHosts -> /tmp/evil` would otherwise let an
  # attacker read the host binary path the browser will launch with
  # the user's privileges (and seed it with a malicious replacement).
  mkdir -p "$dir"
  # `realpath` resolves all symlinks; bail if the resolved path
  # doesn't stay inside $HOME. Use `--logical` is not portable; rely
  # on the default which resolves links.
  local resolved
  if ! resolved="$(realpath "$dir" 2>/dev/null)"; then
    echo "error: cannot resolve $dir" >&2
    exit 1
  fi
  case "$resolved/" in
  "$HOME/"*) ;;
  *)
    echo "error: $dir resolves outside \$HOME ($resolved); refusing to install" >&2
    exit 1
    ;;
  esac
  # Restrict the parent dir to owner-only access. NativeMessagingHosts
  # is typically created by the browser at 0700 anyway, but if we just
  # created it on a fresh install we want the same posture.
  chmod 0700 "$dir"
  local target="$dir/io.drmowinckels.cairn.json"
  # Write to a temp file in the same directory, then atomically move
  # into place — avoids a half-written manifest on disk if the user
  # interrupts the script mid-write.
  local tmp="$dir/.io.drmowinckels.cairn.json.tmp"
  printf '%s' "$rendered" >"$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$target"
  echo "installed: $target"
}

CHROMIUM_MANIFEST="$(render_chromium)"
FIREFOX_MANIFEST="$(render_firefox)"

install_into "$CHROME_DIR" "$CHROMIUM_MANIFEST"
install_into "$CHROMIUM_DIR" "$CHROMIUM_MANIFEST"
install_into "$BRAVE_DIR" "$CHROMIUM_MANIFEST"
install_into "$EDGE_DIR" "$CHROMIUM_MANIFEST"
install_into "$FIREFOX_DIR" "$FIREFOX_MANIFEST"

if [ "$CHROME_EXT_ID" = "@@CHROME_EXT_ID@@" ]; then
  cat <<EOF

note: Chromium manifests were installed with a placeholder allowed_origin.
      After loading the extension unpacked, find its ID via
      chrome://extensions and re-run:

      ./install.sh <extension-id>

EOF
fi
