import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import {
  defaultOpForSignal,
  deserializeRule,
  moveByIndex,
  serializeRule,
  shouldWarnConfidence,
  useRules,
  withConditionAdded,
  withConditionAt,
  withConditionRemoved,
} from "./use-rules";
import type { Rule, RuleCondition } from "./types";

// Mock the IPC layer. We test the hook end-to-end against an
// in-memory backend so we cover the optimistic-update + rollback
// paths in the same harness as the fixture (no-Tauri) path.

vi.mock("./ipc", async () => {
  // We can't reference `backendStore` inside the factory (vi.mock
  // hoists), so put the store inside the factory's closure and
  // re-expose for the test via the mocked module's helpers.
  const store = new Map<string, { id: string; name: string; enabled: boolean; priority: number; body: unknown }>();
  return {
    inTauri: true,
    listRules: vi.fn(async () => Array.from(store.values())),
    saveRule: vi.fn(async (input: { id: string | null; name: string; enabled: boolean; priority: number; body: unknown }) => {
      const id = input.id ?? `id-${store.size + 1}`;
      const row = { id, name: input.name, enabled: input.enabled, priority: input.priority, body: input.body };
      store.set(id, row);
      return row;
    }),
    deleteRule: vi.fn(async (id: string) => {
      store.delete(id);
    }),
    reorderRules: vi.fn(async (ids: string[]) => {
      // Mirror the backend contract: dense 10,20,30,… in the given order.
      ids.forEach((id, i) => {
        const row = store.get(id);
        if (row) store.set(id, { ...row, priority: (i + 1) * 10 });
      });
    }),
    __reset: () => store.clear(),
    __seed: (rules: Array<{ id: string; name: string; enabled: boolean; priority: number; body: unknown }>) => {
      store.clear();
      for (const r of rules) store.set(r.id, r);
    },
  };
});

import * as ipc from "./ipc";

const ipcMock = ipc as typeof ipc & {
  __reset: () => void;
  __seed: (rules: Array<{ id: string; name: string; enabled: boolean; priority: number; body: unknown }>) => void;
};

beforeEach(() => {
  ipcMock.__reset();
  vi.clearAllMocks();
});

describe("serializeRule / deserializeRule", () => {
  it("round-trips a rule through the IPC body shape", () => {
    const original: Rule = {
      id: "r1",
      name: "Cairn",
      enabled: true,
      priority: 10,
      confidence: "strict",
      when: [{ signal: "ide.folder", op: "contains", value: "cairn" }],
      then: { project: "cairn", descriptionTemplate: "Work on {git.branch}" },
      matchedToday: 0,
    };
    const ipcInput = serializeRule(original, "r1");
    const backend = {
      id: ipcInput.id ?? "r1",
      name: ipcInput.name,
      enabled: ipcInput.enabled,
      priority: ipcInput.priority,
      body: ipcInput.body,
    };
    const round = deserializeRule(backend);
    expect(round.id).toBe("r1");
    expect(round.name).toBe("Cairn");
    expect(round.priority).toBe(10);
    expect(round.confidence).toBe("strict");
    expect(round.when).toEqual(original.when);
    expect(round.then.project).toBe("cairn");
    expect(round.then.descriptionTemplate).toBe("Work on {git.branch}");
  });

  it("deserializeRule survives a missing body (rare but possible if migrating)", () => {
    const backend = { id: "x", name: "x", enabled: true, priority: 0, body: null as unknown };
    const r = deserializeRule(backend);
    expect(r.when).toEqual([]);
    expect(r.then).toEqual({ project: null });
  });

  it("round-trips the confidenceWarningDismissed flag through the body", () => {
    // The dismissal is per-rule + persisted (see #14). It lives in
    // the body JSON, which the backend stores as opaque text — so
    // it has to make it both *into* the body on serialize and
    // *back out* on deserialize.
    const original: Rule = {
      id: "r1",
      name: "n",
      enabled: true,
      priority: 10,
      confidence: "strict",
      when: [{ signal: "ide.folder", op: "contains", value: "x" }],
      then: { project: null },
      matchedToday: 0,
      confidenceWarningDismissed: true,
    };
    const ipcInput = serializeRule(original, "r1");
    expect(
      (ipcInput.body as { confidenceWarningDismissed?: boolean })
        .confidenceWarningDismissed,
    ).toBe(true);
    const round = deserializeRule({
      id: "r1",
      name: ipcInput.name,
      enabled: ipcInput.enabled,
      priority: ipcInput.priority,
      body: ipcInput.body,
    });
    expect(round.confidenceWarningDismissed).toBe(true);
  });

  it("omits confidenceWarningDismissed from the body when false (keeps body lean)", () => {
    // Default-falsy doesn't need to take up a slot in the JSON;
    // older rows without the field deserialize cleanly to `false`.
    // Also assert the positive shape so we don't accidentally drop
    // other fields when trimming the dismissed flag.
    const original: Rule = {
      id: "r1",
      name: "n",
      enabled: true,
      priority: 10,
      confidence: "suggestive",
      when: [],
      then: { project: "p" },
      matchedToday: 0,
      confidenceWarningDismissed: false,
    };
    const ipcInput = serializeRule(original, "r1");
    const body = ipcInput.body as Record<string, unknown>;
    expect(
      Object.prototype.hasOwnProperty.call(body, "confidenceWarningDismissed"),
    ).toBe(false);
    expect(body.confidence).toBe("suggestive");
    expect(body.when).toEqual([]);
    expect(body.then).toEqual({ project: "p" });
  });

  it("deserializes a legacy rule (body has no confidenceWarningDismissed key) as not-dismissed", () => {
    // Older rows persisted before #14 landed have no flag at all.
    // The defensive `body.confidenceWarningDismissed === true`
    // check in deserializeRule must produce `false`, not `undefined`.
    const backend = {
      id: "legacy",
      name: "Cairn",
      enabled: true,
      priority: 10,
      body: {
        confidence: "strict",
        when: [{ signal: "ide.folder", op: "contains", value: "cairn" }],
        then: { project: "cairn" },
      },
    };
    const r = deserializeRule(backend);
    expect(r.confidenceWarningDismissed).toBe(false);
    expect(r.confidence).toBe("strict");
  });

  it("ignores a malformed confidenceWarningDismissed value (string / array)", () => {
    // A corrupted or hand-edited body could carry a non-boolean. The
    // strict equality check guards the rest of the editor from a
    // string like "yes" smuggling truthy state into shouldWarnConfidence.
    for (const garbage of ["yes", 1, [], {}, null]) {
      const r = deserializeRule({
        id: "r",
        name: "r",
        enabled: true,
        priority: 10,
        body: {
          confidence: "strict",
          when: [],
          then: { project: null },
          confidenceWarningDismissed: garbage,
        },
      });
      expect(r.confidenceWarningDismissed).toBe(false);
    }
  });
});

describe("moveByIndex", () => {
  it("moves an item forward through the list", () => {
    expect(moveByIndex(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
  });

  it("moves an item backward through the list", () => {
    expect(moveByIndex(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
  });

  it("returns the same array reference for from===to (callers use === to detect no-op)", () => {
    const arr = ["a", "b"];
    expect(moveByIndex(arr, 1, 1)).toBe(arr);
  });

  it("returns the same array reference for out-of-range indices", () => {
    const arr = ["a", "b"];
    expect(moveByIndex(arr, -1, 0)).toBe(arr);
    expect(moveByIndex(arr, 0, 5)).toBe(arr);
    expect(moveByIndex(arr, 5, 0)).toBe(arr);
  });
});

describe("withConditionAt / Added / Removed", () => {
  const base = [
    { signal: "ide.folder" as const, op: "contains" as const, value: "cairn" },
    { signal: "git.branch" as const, op: "starts-with" as const, value: "feat/" },
  ];

  it("withConditionAt patches a single field at the given index", () => {
    const next = withConditionAt(base, 1, { value: "fix/" });
    expect(next[1].value).toBe("fix/");
    expect(next[0]).toBe(base[0]); // unchanged reference
  });

  it("withConditionAdded appends a default condition with the given signal", () => {
    const next = withConditionAdded(base, "calendar.event");
    expect(next).toHaveLength(3);
    expect(next[2].signal).toBe("calendar.event");
  });

  it("withConditionRemoved drops the given index", () => {
    const next = withConditionRemoved(base, 0);
    expect(next).toHaveLength(1);
    expect(next[0].signal).toBe("git.branch");
  });
});

describe("defaultOpForSignal", () => {
  it("returns is-active for calendar.event", () => {
    expect(defaultOpForSignal("calendar.event")).toBe("is-active");
  });

  it("returns contains for substring-shaped signals", () => {
    expect(defaultOpForSignal("ide.folder")).toBe("contains");
    expect(defaultOpForSignal("git.branch")).toBe("contains");
  });
});

describe("useRules hook", () => {
  it("loads rules from the backend on mount", async () => {
    ipcMock.__seed([
      {
        id: "r-from-db",
        name: "DB rule",
        enabled: true,
        priority: 5,
        body: { when: [{ signal: "ide.folder", op: "equals", value: "x" }], then: { project: "p" } },
      },
    ]);
    const { result } = renderHook(() => useRules());
    await waitFor(() => expect(result.current.rules).toHaveLength(1));
    expect(result.current.rules[0].name).toBe("DB rule");
    expect(result.current.rules[0].when[0].value).toBe("x");
    expect(result.current.loading).toBe(false);
  });

  it("add() creates a blank rule and persists it via IPC", async () => {
    const { result } = renderHook(() => useRules());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rules).toHaveLength(0);
    await act(async () => {
      await result.current.add();
    });
    expect(result.current.rules).toHaveLength(1);
    expect(ipc.saveRule).toHaveBeenCalled();
    // Priority should be greater than the seed default (10) when
    // the table is empty.
    expect(result.current.rules[0].priority).toBe(10);
  });

  it("update() applies the patch locally and persists", async () => {
    ipcMock.__seed([
      {
        id: "r1",
        name: "Original",
        enabled: true,
        priority: 10,
        body: { when: [], then: { project: null } },
      },
    ]);
    const { result } = renderHook(() => useRules());
    await waitFor(() => expect(result.current.rules).toHaveLength(1));
    await act(async () => {
      await result.current.update("r1", { name: "Renamed", enabled: false });
    });
    expect(result.current.rules[0].name).toBe("Renamed");
    expect(result.current.rules[0].enabled).toBe(false);
    expect(ipc.saveRule).toHaveBeenCalledWith(
      expect.objectContaining({ id: "r1", name: "Renamed", enabled: false }),
    );
  });

  it("update() keeps the local change on IPC failure (no destructive rollback)", async () => {
    // PR #65 review B2: rolling back the local state on a failed
    // save would silently discard every keystroke the user typed
    // after the save was queued. The hook surfaces the error in
    // `error` but leaves the local state alone — the next mutation
    // will retry the save with whatever the user has by then.
    ipcMock.__seed([
      {
        id: "r1",
        name: "Original",
        enabled: true,
        priority: 10,
        body: { when: [], then: { project: null } },
      },
    ]);
    const { result } = renderHook(() => useRules());
    await waitFor(() => expect(result.current.rules).toHaveLength(1));
    vi.mocked(ipc.saveRule).mockRejectedValueOnce(new Error("DB locked"));
    await act(async () => {
      await result.current.update("r1", { name: "Kept locally" });
    });
    expect(result.current.rules[0].name).toBe("Kept locally");
    expect(result.current.error).toMatch(/DB locked/);
  });

  it("update() merges `then` partials instead of replacing the whole action", async () => {
    // PR #65 review R2: a patch like `{ then: { tagsFromCalendar: true } }`
    // must NOT blow away `then.project`. Previously the contract was
    // muddy — half the editor's onUpdate calls spread `...rule.then`
    // explicitly to avoid this. The hook now does the merge.
    ipcMock.__seed([
      {
        id: "r1",
        name: "R",
        enabled: true,
        priority: 10,
        body: { when: [], then: { project: "cairn", tagsFromCalendar: false } },
      },
    ]);
    const { result } = renderHook(() => useRules());
    await waitFor(() => expect(result.current.rules).toHaveLength(1));
    await act(async () => {
      await result.current.update("r1", { then: { tagsFromCalendar: true } });
    });
    // project must be preserved across the partial-then patch.
    expect(result.current.rules[0].then.project).toBe("cairn");
    expect(result.current.rules[0].then.tagsFromCalendar).toBe(true);
  });

  it("update() handles two rapid same-rule patches without losing either", async () => {
    // PR #65 review R1: stale closure capture in `useCallback` could
    // cause a second rapid `update` to overwrite the first because
    // both built `next` from the same snapshot. The ref-based read
    // means the second call sees the first call's optimistic write.
    ipcMock.__seed([
      {
        id: "r1",
        name: "Start",
        enabled: true,
        priority: 10,
        body: { when: [], then: { project: null } },
      },
    ]);
    const { result } = renderHook(() => useRules());
    await waitFor(() => expect(result.current.rules).toHaveLength(1));
    await act(async () => {
      // First patch lands and the ref is updated before the second
      // patch is dispatched.
      await result.current.update("r1", { name: "Step1" });
      await result.current.update("r1", { enabled: false });
    });
    // Both patches must be reflected; neither overwrote the other.
    expect(result.current.rules[0].name).toBe("Step1");
    expect(result.current.rules[0].enabled).toBe(false);
  });

  it("remove() drops the rule and calls deleteRule IPC", async () => {
    ipcMock.__seed([
      { id: "r1", name: "A", enabled: true, priority: 10, body: { when: [], then: { project: null } } },
      { id: "r2", name: "B", enabled: true, priority: 20, body: { when: [], then: { project: null } } },
    ]);
    const { result } = renderHook(() => useRules());
    await waitFor(() => expect(result.current.rules).toHaveLength(2));
    await act(async () => {
      await result.current.remove("r1");
    });
    expect(result.current.rules.map((r) => r.id)).toEqual(["r2"]);
    expect(ipc.deleteRule).toHaveBeenCalledWith("r1");
  });

  it("shouldWarnConfidence covers every branch of the heuristic", () => {
    // The pure helper backs the editor warning (issue #14, spec §5).
    // The truth table:
    //   suggestive → never warn (regardless of conditions)
    //   strict + <2 conditions → warn
    //   strict + ≥2 conditions all "contains" → warn
    //   strict + ≥2 conditions mixed ops → no warn
    //   any rule with confidenceWarningDismissed → no warn
    const base = (overrides: Partial<Rule>): Rule => ({
      id: "r",
      name: "r",
      enabled: true,
      priority: 10,
      when: [],
      then: { project: null },
      matchedToday: 0,
      ...overrides,
    });
    const ide: RuleCondition = {
      signal: "ide.folder",
      op: "contains",
      value: "x",
    };
    const branch: RuleCondition = {
      signal: "git.branch",
      op: "equals",
      value: "main",
    };

    // Suggestive: never warns, even with the spec's danger shape.
    expect(
      shouldWarnConfidence(
        base({ confidence: "suggestive", when: [ide] }),
      ),
    ).toBe(false);
    expect(
      shouldWarnConfidence(
        base({ confidence: undefined, when: [ide] }),
      ),
    ).toBe(false);

    // Strict + 0 or 1 conditions: warns.
    expect(shouldWarnConfidence(base({ confidence: "strict" }))).toBe(true);
    expect(
      shouldWarnConfidence(base({ confidence: "strict", when: [ide] })),
    ).toBe(true);

    // Strict + 2+ all-contains: warns.
    expect(
      shouldWarnConfidence(
        base({ confidence: "strict", when: [ide, { ...ide, value: "y" }] }),
      ),
    ).toBe(true);

    // Strict + 2+ mixed ops: no warn (a contains-mixed-with-equals
    // rule is specific enough to escape the heuristic).
    expect(
      shouldWarnConfidence(
        base({ confidence: "strict", when: [ide, branch] }),
      ),
    ).toBe(false);

    // Dismissed: silenced regardless of shape.
    expect(
      shouldWarnConfidence(
        base({
          confidence: "strict",
          when: [ide],
          confidenceWarningDismissed: true,
        }),
      ),
    ).toBe(false);
  });

  it("move() reorders rules locally + persists via reorderRules IPC with new ids", async () => {
    ipcMock.__seed([
      { id: "a", name: "A", enabled: true, priority: 10, body: { when: [], then: { project: null } } },
      { id: "b", name: "B", enabled: true, priority: 20, body: { when: [], then: { project: null } } },
      { id: "c", name: "C", enabled: true, priority: 30, body: { when: [], then: { project: null } } },
    ]);
    const { result } = renderHook(() => useRules());
    await waitFor(() => expect(result.current.rules).toHaveLength(3));
    // Move A from index 0 to index 2 → order becomes B, C, A.
    await act(async () => {
      await result.current.move(0, 2);
    });
    expect(result.current.rules.map((r) => r.id)).toEqual(["b", "c", "a"]);
    // Priorities dense + unique 10, 20, 30 (the contract for the backend).
    expect(result.current.rules.map((r) => r.priority)).toEqual([10, 20, 30]);
    // The IPC was called with the new id order — not the old one.
    expect(ipc.reorderRules).toHaveBeenCalledExactlyOnceWith([
      "b",
      "c",
      "a",
    ]);
  });

  it("move() is a no-op when from === to (skips the IPC call entirely)", async () => {
    ipcMock.__seed([
      { id: "a", name: "A", enabled: true, priority: 10, body: { when: [], then: { project: null } } },
      { id: "b", name: "B", enabled: true, priority: 20, body: { when: [], then: { project: null } } },
    ]);
    const { result } = renderHook(() => useRules());
    await waitFor(() => expect(result.current.rules).toHaveLength(2));
    await act(async () => {
      await result.current.move(1, 1);
    });
    expect(ipc.reorderRules).not.toHaveBeenCalled();
  });

  it("move() keeps the local change on IPC failure (no destructive rollback)", async () => {
    // Mirror the policy other mutators use: the next reorder
    // retries with whatever the user has by then. Rolling back
    // would visually snap rules back to a stale position the
    // user has already moved past.
    ipcMock.__seed([
      { id: "a", name: "A", enabled: true, priority: 10, body: { when: [], then: { project: null } } },
      { id: "b", name: "B", enabled: true, priority: 20, body: { when: [], then: { project: null } } },
    ]);
    const { result } = renderHook(() => useRules());
    await waitFor(() => expect(result.current.rules).toHaveLength(2));
    vi.mocked(ipc.reorderRules).mockRejectedValueOnce(new Error("DB locked"));
    await act(async () => {
      await result.current.move(0, 1);
    });
    expect(result.current.rules.map((r) => r.id)).toEqual(["b", "a"]);
    expect(result.current.error).toMatch(/DB locked/);
  });

  it("duplicate() creates a new rule with the original's body + '(copy)' suffix", async () => {
    ipcMock.__seed([
      {
        id: "r1",
        name: "Original",
        enabled: true,
        priority: 10,
        body: {
          when: [{ signal: "ide.folder", op: "contains", value: "cairn" }],
          then: { project: "cairn" },
        },
      },
    ]);
    const { result } = renderHook(() => useRules());
    await waitFor(() => expect(result.current.rules).toHaveLength(1));
    let newId = "";
    await act(async () => {
      newId = await result.current.duplicate("r1");
    });
    expect(result.current.rules).toHaveLength(2);
    const clone = result.current.rules.find((r) => r.id === newId);
    expect(clone?.name).toBe("Original (copy)");
    expect(clone?.priority).toBeGreaterThan(10);
    expect(clone?.when[0].value).toBe("cairn");
  });
});
