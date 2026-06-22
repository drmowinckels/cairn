// Pure, side-effect-free helpers for the Cairn extension service
// worker. Kept in their own module so they can be unit-tested without
// importing the worker (which registers `chrome.*` listeners and opens
// the native-host port at load time).

// Internal browser schemes we never report. Filtering here means the
// native host doesn't wake for `chrome://`, the new-tab page, or other
// extensions' pages. The native host re-validates the domain too.
const INTERNAL_SCHEMES = new Set([
  "chrome:",
  "edge:",
  "brave:",
  "about:",
  "moz-extension:",
  "chrome-extension:",
]);

/** Project a `browser.tabs.Tab` to the native-host wire shape, or
 *  `null` when the tab carries no usable URL (internal pages, the new
 *  tab page, extension pages).
 *
 *  Per PRIVACY.md the URL is parsed here and ONLY `url.hostname`
 *  survives — path, query, hash, title and page contents are never
 *  copied onto the payload (they're absent, not emptied). Incognito
 *  state is reported so the Cairn collector can drop it; the strict
 *  `=== true` keeps the field a real boolean. */
export function projectTab(tab, focused) {
  if (!tab || !tab.url) return null;
  let url;
  try {
    url = new URL(tab.url);
  } catch {
    return null;
  }
  if (INTERNAL_SCHEMES.has(url.protocol)) return null;
  const domain = url.hostname.toLowerCase();
  if (!domain) return null;
  return {
    domain,
    incognito: tab.incognito === true,
    focused,
  };
}

/** Choose the native-messaging transport for the host browser.
 *
 *  Chrome / Edge / Brave / Firefox expose `runtime.connectNative`, a
 *  persistent Port — preferred, because one long-lived connection absorbs
 *  high-frequency tab switches without re-spawning the host. Safari has no
 *  native ports: it routes `runtime.sendNativeMessage` to the in-app
 *  `SafariWebExtensionHandler` (#37), so we fall back to that (one delivery
 *  per message). `connectNative` is the discriminator — it is undefined in
 *  Safari, defined elsewhere. Returns `"none"` when neither exists. */
export function pickNativeTransport(runtime) {
  if (runtime?.connectNative) return "port";
  if (runtime?.sendNativeMessage) return "sendNativeMessage";
  return "none";
}

/** Parse a friendly browser label out of a Chromium-family user-agent
 *  string. Firefox is handled separately via `runtime.getBrowserInfo`;
 *  this covers Chrome / Edge / Brave. Returns the generic `"browser"`
 *  when nothing matches. */
export function parseBrowserLabel(ua) {
  const s = (ua ?? "").toString();
  const m =
    /Edg\/(\d+)/.exec(s) ?? /Brave\/(\d+)/.exec(s) ?? /Chrome\/(\d+)/.exec(s);
  if (!m) return "browser";
  const name = s.includes("Edg/")
    ? "Edge"
    : s.includes("Brave/")
      ? "Brave"
      : "Chrome";
  return `${name} ${m[1]}`;
}
