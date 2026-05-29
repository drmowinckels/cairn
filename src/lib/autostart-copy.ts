// Platform-correct copy for the "start at login" control. The autostart
// mechanism is identical everywhere (tauri-plugin-autostart), but each
// OS has its own conventional phrasing for the same idea, so the label
// is chosen from the running platform.

export type Platform = "macos" | "windows" | "linux" | "unknown";

/** Best-effort platform detection from a user-agent string. In a Tauri
 *  webview `navigator.userAgent` reflects the host OS, so this needs no
 *  extra plugin. Pass `ua` explicitly in tests. */
export function detectPlatform(ua?: string): Platform {
  const s = (
    ua ?? (typeof navigator !== "undefined" ? navigator.userAgent : "")
  ).toString();
  if (/Mac|iPhone|iPad|iPod/i.test(s)) return "macos";
  if (/Windows|Win64|Win32|WOW64/i.test(s)) return "windows";
  if (/Linux|X11|CrOS/i.test(s)) return "linux";
  return "unknown";
}

export interface AutostartCopy {
  /** Switch label, also used as the row name. */
  label: string;
  /** One-line explanation under the control. */
  hint: string;
}

/** Conventional "open at login" phrasing per platform. */
export function autostartCopy(platform: Platform): AutostartCopy {
  switch (platform) {
    case "macos":
      return {
        label: "Open at login",
        hint: "Add Cairn as a macOS login item so it's ready when you sign in.",
      };
    case "windows":
      return {
        label: "Start with Windows",
        hint: "Register Cairn in the Windows startup list so it launches with your session.",
      };
    case "linux":
      return {
        label: "Start on session login",
        hint: "Add a desktop autostart entry so Cairn launches when your session begins.",
      };
    default:
      return {
        label: "Start at login",
        hint: "Launch Cairn automatically when you sign in.",
      };
  }
}
