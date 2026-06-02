import { useEffect, useState } from "react";

/**
 * Reactive read of `<html data-colorblind>` so consumers can recompute
 * `cbColor(project.color, enabled)` without each call site importing
 * the full `useA11yPrefs` hook. The pref hook already writes the data
 * attribute on every change (see `use-a11y-prefs.ts`); a MutationObserver
 * picks that up here.
 *
 * SSR-safe: returns `false` before mount, then settles on the actual
 * value once the observer attaches.
 */
export function useColorblindEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    const read = () => setEnabled(root.dataset.colorblind === "on");
    read();
    const mo = new MutationObserver(read);
    mo.observe(root, {
      attributes: true,
      attributeFilter: ["data-colorblind"],
    });
    return () => mo.disconnect();
  }, []);

  return enabled;
}
