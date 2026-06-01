import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { inTauri } from "./ipc";

/**
 * Hide the About window — the × button and Escape both call this. The window
 * is created hidden and shown by the tray's "About Cairn" item, so we hide
 * (not close) it for reuse. No-op outside Tauri (Vite/vitest).
 */
export async function hideAboutWindow(): Promise<void> {
  if (!inTauri) return;
  await getCurrentWebviewWindow().hide();
}
