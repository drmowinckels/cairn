import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import globals from "globals";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    // Build output, vendored configs, and the Rust/docs/extension trees
    // are out of scope — the frontend lint surface is `src/`.
    ignores: [
      "dist",
      "coverage",
      "node_modules",
      "src-tauri",
      "browser-extension",
      "docs",
      "scripts",
      "public",
      "design",
      "*.config.{js,ts}",
      "src/vite-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "jsx-a11y": jsxA11y,
    },
    rules: {
      // Long-standing hook-correctness core. We deliberately do NOT pull
      // in react-hooks 7's full `recommended-latest`, which bundles the
      // React Compiler rules (set-state-in-effect, refs-during-render).
      // Those target Compiler adoption; this app doesn't use the Compiler
      // and its draft-sync / stable-key-ref patterns are intentional.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      ...jsxA11y.flatConfigs.recommended.rules,
      // Underscore-prefixed bindings are intentionally unused (ignored
      // callback args, placeholder destructures).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Shipping UI must resolve project/entry data from live state, never
      // from the demo fixtures — importing them silently breaks real builds
      // where the fixture ids don't exist (#138). Tests re-enable this below.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/test-fixtures/*", "**/test-fixtures/**"],
              message:
                "Don't import test fixtures from shipping code — resolve from live state (useProjects, props). Fixtures are for *.test.* and test setup only.",
            },
          ],
        },
      ],
    },
  },
  {
    // Test files and the shared test setup are allowed to pull in fixtures.
    files: [
      "src/**/*.test.{ts,tsx}",
      "src/test-fixtures/**/*.{ts,tsx}",
      "src/test-setup.{ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  {
    // Pre-existing modules that pull fixtures in deliberately: the
    // `inTauri ? live : FIXTURE` browser-dev fallbacks and the static
    // label maps that still live in the fixtures file. These are not the
    // #138 bug (resolving *production* data from fixtures) — they degrade
    // gracefully outside Tauri. Listed explicitly so the ban still catches
    // any *new* accidental fixture import in shipping code.
    files: [
      "src/lib/use-projects.ts",
      "src/lib/use-clients.ts",
      "src/lib/use-rules.ts",
      "src/lib/report-fixture.ts",
      "src/views/rules/rules.tsx",
      "src/views/rules/live-signals-card.tsx",
      "src/views/data/data-tree.tsx",
    ],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  // Disable every stylistic rule that would conflict with Prettier; must
  // stay last so it wins.
  prettier,
);
