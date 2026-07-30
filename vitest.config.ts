import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    globals: false,
    setupFiles: ["./src/test-setup.ts"],
    // The heaviest interaction tests re-import their module graph per test
    // (`vi.resetModules()` + a dynamic `import()`) on top of many `userEvent`
    // steps. Each passes comfortably alone, but under full-suite parallelism
    // the shared CPU pushes some past Vitest's default 5s, so they flaked (#157).
    // A high ceiling lets even a badly-starved test finish rather than time out;
    // real assertion failures still fail immediately — only genuine hangs wait.
    testTimeout: 30000,
    // Backstop for the rare remaining contention timeout. Only non-deterministic
    // failures benefit — a wrong assertion fails every attempt — so this rescues
    // load flakiness (#157) without hiding real bugs.
    retry: 1,
    include: [
      "src/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "scripts/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "browser-extension/src/**/*.{test,spec}.?(c|m)[jt]s?(x)",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "coverage",
      include: ["src/**/*.{ts,tsx}", "browser-extension/src/**/*.js"],
      exclude: [
        "src/**/*.{test,spec}.?(c|m)[jt]s?(x)",
        "src/test-setup.ts",
        "src/test-fixtures/**",
        "src/main.tsx",
        "src/vite-env.d.ts",
        "browser-extension/src/**/*.{test,spec}.?(c|m)[jt]s?(x)",
        "browser-extension/src/service-worker.js",
      ],
    },
  },
});
