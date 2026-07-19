import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { axe } from "vitest-axe";
import "vitest-axe/extend-expect";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn(),
}));
vi.mock("../../lib/use-suggestion", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/use-suggestion")>();
  return {
    ...actual,
    useSuggestion: () => ({
      suggestion: {
        ruleId: "r1",
        ruleName: "Cairn dev",
        confidence: "suggestive" as const,
        project: "cairn",
        tags: ["dev"],
      },
      confirm: vi.fn(),
      dismiss: vi.fn(),
    }),
  };
});

import { Popover } from "./popover";
import type { View } from "../../lib/types";

const AXE_OPTIONS = {
  runOnly: {
    type: "tag" as const,
    values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
  },
  rules: {
    // color-contrast relies on getComputedStyle resolving CSS
    // variables, which happy-dom does not. The puppeteer audit in
    // scripts/audit-a11y.mjs covers contrast on a real Chromium.
    "color-contrast": { enabled: false },
  },
};

beforeEach(() => {
  document.body.removeAttribute("data-theme");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Popover · axe a11y", () => {
  const views: View[] = ["today", "reports", "rules", "settings"];

  for (const view of views) {
    it(`has no axe violations on the ${view} view`, async () => {
      const { container } = render(<Popover initialView={view} />);
      const results = await axe(container, AXE_OPTIONS);
      expect(results).toHaveNoViolations();
    });
  }
});
