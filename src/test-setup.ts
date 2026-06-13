import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// Global stub for `@tauri-apps/api/event`. The real module needs the
// Tauri IPC bridge that vitest never wires up; without this stub,
// any component using `useSuggestion` (or any future listen-based
// hook) would crash the test on mount when `__TAURI_INTERNALS__` is
// set. Tests that need to drive event payloads through `listen`
// should inject a fake `listen` via the hook's options instead.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  once: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

// jsdom has no ResizeObserver; the Treemap (reports view) observes its
// container to size tiles. A no-op stub lets it mount — tests that need a
// concrete width stub `clientWidth` directly.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    key: (i) => Array.from(store.keys())[i] ?? null,
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
  if (typeof globalThis.window !== "undefined") {
    Object.defineProperty(globalThis.window, "localStorage", {
      value: storage,
      configurable: true,
    });
  }
}

afterEach(() => {
  cleanup();
});
