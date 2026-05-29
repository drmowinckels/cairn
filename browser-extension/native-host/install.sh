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
  mkdir -p "$dir"
  local target="$dir/io.drmowinckels.cairn.json"
  printf '%s' "$rendered" >"$target"
  chmod 0644 "$target"
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
