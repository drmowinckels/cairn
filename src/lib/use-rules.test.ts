import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import {
  defaultOpForSignal,
  deserializeRule,
  serializeRule,
  useRules,
  withConditionAdded,
  withConditionAt,
  withConditionRemoved,
} from "./use-rules";
import type { Rule } from "./types";

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
