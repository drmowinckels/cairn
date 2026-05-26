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

  it("inputs have autoComplete=off + spellCheck=false (avoid noise on developer-y values)", () => {
    const { getByLabelText } = render(<RuleTestBench />);
    const folder = getByLabelText("IDE folder") as HTMLInputElement;
    expect(folder.getAttribute("autocomplete")).toBe("off");
    expect(folder.getAttribute("spellcheck")).toBe("false");
  });

  it("fires dryRunRules on mount with the default snapshot (no debounce on first fire)", async () => {
    render(<RuleTestBench />);
    await waitFor(() => {
      expect(ipc.dryRunRules).toHaveBeenCalledWith({
        ideFolder: "~/code/cairn",
        gitBranch: "feat/rules-ui",
        windowTitle: "rules.tsx — cairn",
      });
    });
    // Mount must fire exactly once — the second-render path runs
    // through the debounce, so a too-eager mount handler would
    // double-up.
    expect(ipc.dryRunRules).toHaveBeenCalledOnce();
  });

  it("debounces keystroke changes: 5 rapid edits → 1 IPC, called with the LAST value", async () => {
    const { getByLabelText } = render(<RuleTestBench />);
    // Wait for mount-fire so we can isolate change-fires.
    await waitFor(() => expect(ipc.dryRunRules).toHaveBeenCalledOnce());
    vi.mocked(ipc.dryRunRules).mockClear();
    const branch = getByLabelText("Git branch");
    for (const v of ["a", "ab", "abc", "abcd", "abcde"]) {
      fireEvent.change(branch, { target: { value: v } });
    }
    // The debounce window is 150ms; the test waits up to 1s by default.
    await waitFor(() => {
      expect(ipc.dryRunRules).toHaveBeenCalledOnce();
    });
    expect(ipc.dryRunRules).toHaveBeenCalledWith(
      expect.objectContaining({ gitBranch: "abcde" }),
    );
  });

  it("ignores a stale-resolving response (race-safe via requestId)", async () => {
    // Set up two pending calls that resolve out of order. Without
    // the requestId guard, the first (stale) resolution would
    // overwrite the second's result. With the guard, only the
    // latest dispatched call's result lands.
    let resolveFirst!: (r: DryRunResult | null) => void;
    let resolveSecond!: (r: DryRunResult | null) => void;
    vi.mocked(ipc.dryRunRules)
      .mockImplementationOnce(
        () =>
          new Promise<DryRunResult | null>((res) => {
            resolveFirst = res;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<DryRunResult | null>((res) => {
            resolveSecond = res;
          }),
      );
    const { getByLabelText, container } = render(<RuleTestBench />);
    // Mount fires the first call (slow). Now change a field to fire
    // the second; the debounce flushes after 150ms.
    fireEvent.change(getByLabelText("Git branch"), {
      target: { value: "fix/x" },
    });
    await waitFor(() => {
      expect(ipc.dryRunRules).toHaveBeenCalledTimes(2);
    });
    // Resolve the SECOND call first with a real match.
    resolveSecond({
      ruleId: "r2",
      ruleName: "Second match",
      confidence: "suggestive",
      project: "p2",
      tags: [],
      description: "",
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/Second match/);
    });
    // Now resolve the FIRST (stale) call with a different match —
    // the guard must drop it on the floor.
    resolveFirst({
      ruleId: "r1",
      ruleName: "First match",
      confidence: "suggestive",
      project: "p1",
      tags: [],
      description: "",
    });
    // Flush microtasks.
    await Promise.resolve();
    await Promise.resolve();
    // Still showing the second match — first did not clobber.
    expect(container.textContent).toMatch(/Second match/);
    expect(container.textContent).not.toMatch(/First match/);
  });

  it("drops a whitespace-only value to null so the engine ignores it", async () => {
    const { getByLabelText } = render(<RuleTestBench />);
    await waitFor(() => expect(ipc.dryRunRules).toHaveBeenCalledOnce());
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

  it("renders a match without a project (no chip, no '→ assigns' phrase)", async () => {
    // The `then.project` field is optional — a rule can set tags
    // without changing the project. The match row must handle that
    // branch cleanly (project? : null on both the chip and the
    // 'assigns' phrase).
    const match: DryRunResult = {
      ruleId: "r1",
      ruleName: "Tag-only rule",
      confidence: "suggestive",
      project: null,
      tags: ["meeting"],
      description: "",
    };
    vi.mocked(ipc.dryRunRules).mockResolvedValue(match);
    const { container } = render(<RuleTestBench />);
    await waitFor(() => {
      expect(container.textContent).toMatch(/Tag-only rule/);
    });
    // No assigns phrase + no project chip.
    expect(container.textContent).not.toMatch(/→ assigns/);
    // Tags wrapper still renders (the rule has one tag).
    expect(container.querySelector(".bench-tags")).toBeTruthy();
  });

  it("re-fires dryRunRules when the IDE folder field changes", async () => {
    const { getByLabelText } = render(<RuleTestBench />);
    await waitFor(() => expect(ipc.dryRunRules).toHaveBeenCalledOnce());
    vi.mocked(ipc.dryRunRules).mockClear();
    fireEvent.change(getByLabelText("IDE folder"), {
      target: { value: "~/code/other" },
    });
    await waitFor(() => {
      expect(ipc.dryRunRules).toHaveBeenCalledWith(
        expect.objectContaining({ ideFolder: "~/code/other" }),
      );
    });
  });

  it("re-fires dryRunRules when the Window title field changes", async () => {
    const { getByLabelText } = render(<RuleTestBench />);
    await waitFor(() => expect(ipc.dryRunRules).toHaveBeenCalledOnce());
    vi.mocked(ipc.dryRunRules).mockClear();
    fireEvent.change(getByLabelText("Window title"), {
      target: { value: "new title" },
    });
    await waitFor(() => {
      expect(ipc.dryRunRules).toHaveBeenCalledWith(
        expect.objectContaining({ windowTitle: "new title" }),
      );
    });
  });

  it("surfaces a backend error with role=alert (announced by screen readers)", async () => {
    vi.mocked(ipc.dryRunRules).mockRejectedValue(
      new Error("rules cache poisoned"),
    );
    const { container } = render(<RuleTestBench />);
    await waitFor(() => {
      expect(
        container.querySelector(".bench-result--err"),
      ).toBeTruthy();
    });
    const errRow = container.querySelector(".bench-result--err")!;
    expect(errRow.getAttribute("role")).toBe("alert");
    expect(errRow.textContent).toMatch(/dry-run failed/i);
  });

  it("recovers from a transient error on the next snapshot change", async () => {
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
