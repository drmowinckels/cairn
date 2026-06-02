import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

// Isolated test file so we can use a single `vi.mock` with
// `inTauri: false` without fighting the hoisting + module-cache
// interaction that bit us in the original mixed `vi.mock` +
// `vi.doMock` setup (reviewer R3 on #13). vitest scopes mocks by
// file, so a separate file is the simplest path to a clean state.
vi.mock("../../lib/ipc", async (importActual) => {
  const actual = await importActual<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    inTauri: false,
    // Mirror the real `dryRunRules` behavior outside Tauri: it
    // short-circuits to null rather than throwing.
    dryRunRules: vi.fn(async () => null),
  };
});

import { RuleTestBench } from "./test-bench";

describe("RuleTestBench (outside Tauri)", () => {
  it("shows 'preview unavailable outside the app' instead of 'no rule matches'", async () => {
    const { container } = render(<RuleTestBench />);
    await waitFor(() => {
      expect(container.querySelector(".bench-result--none")).toBeTruthy();
    });
    expect(container.querySelector(".bench-result--none")?.textContent).toMatch(
      /preview unavailable outside the app/i,
    );
  });
});
