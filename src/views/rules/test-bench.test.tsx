import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";

import { RuleTestBench } from "./test-bench";
import type { DryRunResult } from "../../lib/ipc";

vi.mock("../../lib/ipc", async (importActual) => {
  const actual = await importActual<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    inTauri: true,
    dryRunRules: vi.fn(async () => null),
  };
});

import * as ipc from "../../lib/ipc";

afterEach(() => {
  vi.clearAllMocks();
});

describe("RuleTestBench", () => {
  it("renders three labeled inputs prefilled with the default snapshot", () => {
    const { getByLabelText } = render(<RuleTestBench />);
    const folder = getByLabelText("IDE folder") as HTMLInputElement;
    const branch = getByLabelText("Git branch") as HTMLInputElement;
    const title = getByLabelText("Window title") as HTMLInputElement;
    expect(folder.value).toBe("~/code/cairn");
    expect(branch.value).toBe("feat/rules-ui");
    expect(title.value).toBe("rules.tsx — cairn");
  });

  it("fires dryRunRules on mount with the default snapshot", async () => {
    render(<RuleTestBench />);
    await waitFor(() => {
      expect(ipc.dryRunRules).toHaveBeenCalledWith({
        ideFolder: "~/code/cairn",
        gitBranch: "feat/rules-ui",
        windowTitle: "rules.tsx — cairn",
      });
    });
  });

  it("fires dryRunRules with the updated snapshot when a field changes", async () => {
    const { getByLabelText } = render(<RuleTestBench />);
    vi.mocked(ipc.dryRunRules).mockClear();
    fireEvent.change(getByLabelText("Git branch"), {
      target: { value: "fix/auth" },
    });
    await waitFor(() => {
      expect(ipc.dryRunRules).toHaveBeenCalledWith(
        expect.objectContaining({ gitBranch: "fix/auth" }),
      );
    });
  });

  it("drops a whitespace-only value to null so the engine ignores it", async () => {
    const { getByLabelText } = render(<RuleTestBench />);
    vi.mocked(ipc.dryRunRules).mockClear();
    fireEvent.change(getByLabelText("Git branch"), {
      target: { value: "   " },
    });
    await waitFor(() => {
      expect(ipc.dryRunRules).toHaveBeenCalledWith(
        expect.objectContaining({ gitBranch: null }),
      );
    });
  });

  it("renders the 'no rule matches' row when dryRunRules returns null (in Tauri)", async () => {
    vi.mocked(ipc.dryRunRules).mockResolvedValue(null);
    const { container } = render(<RuleTestBench />);
    await waitFor(() => {
      expect(
        container.querySelector(".bench-result--none"),
      ).toBeTruthy();
    });
    expect(
      container.querySelector(".bench-result--none")?.textContent,
    ).toMatch(/no rule matches/i);
  });

  it("renders the match row with rule name, project chip + tags", async () => {
    const match: DryRunResult = {
      ruleId: "r1",
      ruleName: "Cairn dev work",
      confidence: "suggestive",
      project: "cairn",
      tags: ["dev", "feature"],
      description: "",
    };
    vi.mocked(ipc.dryRunRules).mockResolvedValue(match);
    const { container } = render(<RuleTestBench />);
    await waitFor(() => {
      expect(container.textContent).toMatch(/matches/i);
      expect(container.textContent).toMatch(/Cairn dev work/);
    });
    // ProjectChip + Tag components render their own elements; assert
    // by counting the tag children — bench-tags wrapper exists only
    // when there's at least one tag.
    expect(container.querySelector(".bench-tags")).toBeTruthy();
    const tags = container.querySelectorAll(".bench-tags > *");
    expect(tags.length).toBe(2);
  });

  it("omits the tags wrapper when the rule match carries no tags", async () => {
    const match: DryRunResult = {
      ruleId: "r1",
      ruleName: "Project only",
      confidence: "suggestive",
      project: "cairn",
      tags: [],
      description: "",
    };
    vi.mocked(ipc.dryRunRules).mockResolvedValue(match);
    const { container } = render(<RuleTestBench />);
    await waitFor(() => {
      expect(container.textContent).toMatch(/Project only/);
    });
    expect(container.querySelector(".bench-tags")).toBeNull();
  });

  it("surfaces a backend error in the result row", async () => {
    vi.mocked(ipc.dryRunRules).mockRejectedValue(
      new Error("rules cache poisoned"),
    );
    const { container } = render(<RuleTestBench />);
    await waitFor(() => {
      expect(
        container.querySelector(".bench-result--err"),
      ).toBeTruthy();
    });
    expect(
      container.querySelector(".bench-result--err")?.textContent,
    ).toMatch(/dry-run failed/i);
  });

  it("recovers from a transient error on the next snapshot change", async () => {
    // First call throws, second call succeeds — the result row must
    // transition back to a clean state once a successful call lands.
    vi.mocked(ipc.dryRunRules)
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({
        ruleId: "r1",
        ruleName: "Cairn dev work",
        confidence: "suggestive",
        project: "cairn",
        tags: [],
        description: "",
      });
    const { container, getByLabelText } = render(<RuleTestBench />);
    await waitFor(() =>
      expect(container.querySelector(".bench-result--err")).toBeTruthy(),
    );
    fireEvent.change(getByLabelText("Git branch"), {
      target: { value: "fix/x" },
    });
    await waitFor(() => {
      expect(container.querySelector(".bench-result--err")).toBeNull();
      expect(container.textContent).toMatch(/Cairn dev work/);
    });
  });
});

describe("RuleTestBench outside Tauri", () => {
  it("shows 'preview unavailable' when inTauri=false", async () => {
    // Re-mock with inTauri = false for this single test. The shared
    // mock above sets it true; reset + re-apply per the spec's
    // "non-Tauri build" case.
    vi.doMock("../../lib/ipc", async (importActual) => {
      const actual = await importActual<typeof import("../../lib/ipc")>();
      return { ...actual, inTauri: false, dryRunRules: async () => null };
    });
    vi.resetModules();
    const { RuleTestBench: ReloadedBench } = await import("./test-bench");
    const { container } = render(<ReloadedBench />);
    await waitFor(() => {
      expect(
        container.querySelector(".bench-result--none")?.textContent,
      ).toMatch(/preview unavailable/i);
    });
    vi.doUnmock("../../lib/ipc");
  });
});
