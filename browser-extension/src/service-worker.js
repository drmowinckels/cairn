// Cairn browser extension — active-tab signal.
//
// This service worker is the entire extension. It listens for
// `tabs.onActivated`, `tabs.onUpdated`, and `windows.onFocusChanged`,
// projects the events down to `{domain, focused, incognito, browserLabel}`,
// and forwards them to the Cairn native messaging host
// (`io.drmowinckels.cairn`). The host writes newline-delimited JSON to
// the local IPC socket the main app listens on
// (`~/.cairn/ipc/sock` on Unix, `\\.\pipe\cairn` on Windows).
//
// Per `docs/PRIVACY.md` and the manifest description:
//
// - **Only the domain crosses the wire.** Path, query string, hash, page
//   contents — none of those reach the native host. The URL is parsed
//   here in the worker; only `url.hostname` is included in the message.
// - **Incognito / private windows are flagged.** Tabs from those
//   contexts are still announced (so the main app can keep its
//   "extension connected" heartbeat alive) but with `incognito: true`,
//   which the Rust collector drops before reaching the rules engine.
// - **No analytics, no remote endpoints.** The extension talks to the
//   native host on this machine and nothing else.
//
// The native host is opened lazily and held in a single `Port` for the
// life of the worker. If it disconnects (host crashed, app not running),
// subsequent messages are dropped silently until we re-open on the next
// event.

const NATIVE_HOST = "io.drmowinckels.cairn";

/** Bridge to the native messaging host. Lazily opened; re-opens after
 *  any disconnect. */
let port = null;
/** Cached `runtime.getBrowserInfo()` (Firefox) or UA string (Chromium)
 *  used to label the connection in Settings → Integrations. */
let browserLabel = null;

/** Compute (and cache) a friendly browser label. Firefox exposes
 *  `runtime.getBrowserInfo` and Chromium tells us via the user agent.
 *  Either way the result is something like `"Firefox 124"` or
 *  `"Chrome 120"`. */
async function getBrowserLabel() {
  if (browserLabel) return browserLabel;
  try {
    if (typeof browser !== "undefined" && browser.runtime.getBrowserInfo) {
      const info = await browser.runtime.getBrowserInfo();
      browserLabel = `${info.name} ${info.version.split(".")[0]}`;
      return browserLabel;
    }
  } catch {
    /* fall through to UA */
  }
  // Best-effort UA parse for Chromium-family browsers (Chrome, Edge,
  // Brave, etc.). We avoid `navigator.userAgentData` because it's still
  // gated behind `permissions: ["userAgent"]` in some channels.
  const ua = (globalThis.navigator?.userAgent ?? "").toString();
  const m =
    /Edg\/(\d+)/.exec(ua) ??
    /Brave\/(\d+)/.exec(ua) ??
    /Chrome\/(\d+)/.exec(ua);
  if (m) {
    const name = ua.includes("Edg/")
      ? "Edge"
      : ua.includes("Brave/")
      ? "Brave"
      : "Chrome";
    browserLabel = `${name} ${m[1]}`;
  } else {
    browserLabel = "browser";
  }
  return browserLabel;
}

// Security review R3 on PR #87: `connectNative` is invoked
// synchronously — no `await` between the null-check and the
// assignment — and the `onDisconnect` handler closes over the local
// `current` binding rather than the module-global. Two listeners
// firing in the same microtask tick can no longer both call
// `connectNative` and stomp each other; the second `getPort()`
// returns the already-open instance. If `current` disconnects, only
// THAT port's handler nulls the global — it doesn't accidentally
// null a successor port that was opened in the meantime.
function getPort() {
  if (port) return port;
  try {
    const current = chrome.runtime.connectNative(NATIVE_HOST);
    current.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      if (err) {
        // The Cairn app isn't running, or the native-host manifest
        // isn't registered. Either way: drop the port and let the
        // next event re-open. Don't log loudly — this is the steady
        // state when the user hasn't started Cairn yet.
      }
      if (port === current) port = null;
    });
    port = current;
  } catch (e) {
    port = null;
  }
  return port;
}

/** Best-effort send of a single message. Returns silently on failure;
 *  the main app's heartbeat sidebar surfaces "extension disconnected"
 *  if no message arrives within 60s. */
function sendMessage(payload) {
  const p = getPort();
  if (!p) return;
  try {
    p.postMessage(payload);
  } catch {
    port = null;
  }
}

/** Project a `browser.tabs.Tab` to the native-host wire shape. Returns
 *  null when the tab carries no usable URL (chrome:// pages, the new
 *  tab page, extension pages — none of which the user typically wants
 *  in a time entry). */
function project(tab, focused) {
  if (!tab || !tab.url) return null;
  let url;
  try {
    url = new URL(tab.url);
  } catch {
    return null;
  }
  // Filter out the always-noisy schemes. The native host re-validates
  // anyway, but bailing here avoids waking the host for every internal
  // page transition.
  if (
    url.protocol === "chrome:" ||
    url.protocol === "edge:" ||
    url.protocol === "brave:" ||
    url.protocol === "about:" ||
    url.protocol === "moz-extension:" ||
    url.protocol === "chrome-extension:"
  ) {
    return null;
  }
  const domain = url.hostname.toLowerCase();
  if (!domain) return null;
  return {
    domain,
    // Per PRIVACY.md: the extension MUST NOT send the path, query, or
    // any tab content. The native host strips path/title too, but the
    // privacy contract is that the data never leaves the browser
    // boundary in the first place — these fields are absent, not
    // emptied.
    incognito: tab.incognito === true,
    focused,
  };
}

async function announceActiveTab(tab, focused) {
  if (!tab) return;
  const payload = project(tab, focused);
  if (!payload) return;
  // Security review R5 on PR #87: skip browserLabel for incognito.
  // Reading `getBrowserInfo` / `userAgent` is fine here, but
  // attaching the label tells the native host (and downstream
  // Integrations card) that an incognito session is producing
  // signals — which is more than the collector needs. The Cairn
  // collector drops incognito frames before the rules engine, so
  // the label only travels with non-incognito payloads anyway.
  if (!payload.incognito) {
    payload.browserLabel = await getBrowserLabel();
  }
  sendMessage(payload);
}

// ---- Event wiring --------------------------------------------------

// Tab activated in a window we know about. Look up the tab to get
// its URL + incognito flag — the event itself carries only the IDs.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await announceActiveTab(tab, true);
  } catch {
    /* tab gone before we could read it; ignore */
  }
});

// A tab we know about changed URL. We only care about the active tab
// in the focused window — otherwise a background tab updating its
// favicon would spam events.
chrome.tabs.onUpdated.addListener(async (_tabId, _changeInfo, tab) => {
  if (!tab.active) return;
  // `chrome.windows.WINDOW_ID_NONE` after a focus loss still leaves
  // `tab.active` true for its owning window. We rely on the focused
  // window's tab being announced again via `windows.onFocusChanged`
  // below, so an inactive-window update can still fire here — it's
  // labelled `focused: false`.
  let focused = true;
  try {
    const win = await chrome.windows.get(tab.windowId);
    focused = win.focused;
  } catch {
    /* window gone; assume focused */
  }
  await announceActiveTab(tab, focused);
});

// Window focus changed. `WINDOW_ID_NONE` means the browser itself lost
// focus (the user switched to another app). We still send a heartbeat
// — `focused: false` — so the main app's Integrations card can tell
// "extension is alive" vs "extension crashed".
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    sendMessage({
      domain: "",
      focused: false,
      incognito: false,
      browserLabel: await getBrowserLabel(),
    });
    return;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab) await announceActiveTab(tab, true);
  } catch {
    /* window gone; ignore */
  }
});

// Open the port eagerly so a freshly-launched Cairn sees the extension
// immediately. If the app isn't running yet the connect will fail and
// `port` resets to null — the next event re-opens.
getPort();
