import { useEffect, useState } from "react";
import { listAppCategories, type AppCategory } from "./ipc";

// The app→category table is compiled into the binary and never changes at
// runtime, so fetch it once and share it across every consumer (the rule
// editor renders one per `app.category` condition row).
let cache: AppCategory[] | null = null;
let inflight: Promise<AppCategory[]> | null = null;

/** The bundled app→category table (#189), fetched once per session. Returns
 *  `[]` until loaded and outside Tauri; a fetch failure is non-fatal — the
 *  helper text simply doesn't render. */
export function useAppCategories(): AppCategory[] {
  const [categories, setCategories] = useState<AppCategory[]>(cache ?? []);

  useEffect(() => {
    if (cache) return;
    let active = true;
    inflight ??= listAppCategories();
    inflight
      .then((cats) => {
        cache = cats;
        if (active) setCategories(cats);
      })
      .catch(() => {
        // Reset so a later mount can retry; helper text is optional.
        inflight = null;
      });
    return () => {
      active = false;
    };
  }, []);

  return categories;
}
