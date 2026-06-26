// Resolve the OS locale once at boot and expose it to date/time formatters.
//
// The Tauri WKWebView reports `navigator.language` as `en-US` regardless of
// the macOS region, so `toLocaleDateString(undefined, …)` formats dates in
// US order (M/D/Y) even for a user whose Mac is set to, say, Norway. The
// Rust `system_locale` command reads the real OS locale; we resolve it once
// and pass it explicitly to `Intl`/`toLocale*`.

import { systemLocale } from "./ipc";

let resolved: string | undefined;

/** Fetch the OS locale once (call at boot, before first render). Falls back
 *  silently to the webview's own locale if the backend is unavailable. Also
 *  tags `<html lang>` so the document advertises the right language. */
export async function initLocale(): Promise<void> {
  try {
    resolved = (await systemLocale()) ?? undefined;
  } catch {
    resolved = undefined;
  }
  const lang = appLocale();
  if (lang && typeof document !== "undefined") {
    document.documentElement.lang = lang;
  }
}

/** The locale to pass to `Intl` / `toLocale*`. Prefers the OS locale; falls
 *  back to the webview's `navigator.language`, then `undefined` (Intl's own
 *  default). */
export function appLocale(): string | undefined {
  return resolved ?? globalThis.navigator?.language ?? undefined;
}

/** Test-only: override the resolved locale so formatter tests are
 *  deterministic regardless of the runner's environment. */
export function setLocaleForTest(locale: string | undefined): void {
  resolved = locale;
}
