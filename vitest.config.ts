import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    globals: false,
    setupFiles: ["./src/test-setup.ts"],
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
