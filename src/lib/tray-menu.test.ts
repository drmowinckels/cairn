import { describe, it, expect, vi } from "vitest";
import {
  buildTrayMenuModel,
  formatElapsed,
  formatTrayStatus,
  pushTrayMenuIfChanged,
  resolveRunningProjectName,
  type TrayMenuModel,
} from "./tray-menu";

describe("formatElapsed", () => {
  it("renders sub-hour spans as minutes", () => {
    expect(formatElapsed(0)).toBe("0m");
    expect(formatElapsed(59_000)).toBe("0m");
    expect(formatElapsed(5 * 60_000)).toBe("5m");
    expect(formatElapsed(59 * 60_000)).toBe("59m");
  });

  it("rolls up to hours past 60 minutes", () => {
    expect(formatElapsed(60 * 60_000)).toBe("1h 0m");
    expect(formatElapsed(83 * 60_000)).toBe("1h 23m");
    expect(formatElapsed(125 * 60_000)).toBe("2h 5m");
  });

  it("clamps non-finite or negative input to 0m", () => {
    expect(formatElapsed(-1)).toBe("0m");
    expect(formatElapsed(Number.NaN)).toBe("0m");
    expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe("0m");
  });
});

describe("formatTrayStatus", () => {
  it("reports not-tracking when idle regardless of other args", () => {
    expect(formatTrayStatus(false, "Cairn", 99 * 60_000)).toBe("Not tracking");
    expect(formatTrayStatus(false, null, 0)).toBe("Not tracking");
  });

  it("names the project when tracking one", () => {
    expect(formatTrayStatus(true, "Cairn", 83 * 60_000)).toBe(
      "Tracking: Cairn — 1h 23m",
    );
  });

  it("omits the project when tracking without one", () => {
    expect(formatTrayStatus(true, null, 5 * 60_000)).toBe("Tracking — 5m");
    expect(formatTrayStatus(true, "   ", 5 * 60_000)).toBe("Tracking — 5m");
  });
});

describe("resolveRunningProjectName", () => {
  const projects = [
    { id: "a", name: "Alpha" },
    { id: "b", name: "Beta" },
  ];

  it("returns null when nothing is running", () => {
    expect(resolveRunningProjectName(null, projects)).toBeNull();
  });

  it("returns null when the running entry has no project", () => {
    expect(resolveRunningProjectName({ projectId: null }, projects)).toBeNull();
  });

  it("returns null when the project id isn't found", () => {
    expect(
      resolveRunningProjectName({ projectId: "missing" }, projects),
    ).toBeNull();
  });

  it("returns the matching project's name", () => {
    expect(resolveRunningProjectName({ projectId: "b" }, projects)).toBe(
      "Beta",
    );
  });
});

describe("buildTrayMenuModel", () => {
  it("assembles status, running flag and projects when tracking", () => {
    const model = buildTrayMenuModel({
      running: { projectId: "a" },
      elapsedMs: 60_000,
      projects: [
        { id: "a", name: "Alpha" },
        { id: "b", name: "Beta" },
      ],
    });
    expect(model).toEqual({
      statusLabel: "Tracking: Alpha — 1m",
      isRunning: true,
      projects: [
        { id: "a", name: "Alpha" },
        { id: "b", name: "Beta" },
      ],
    });
  });

  it("produces a not-tracking model with an empty project list", () => {
    const model = buildTrayMenuModel({
      running: null,
      elapsedMs: 0,
      projects: [],
    });
    expect(model).toEqual({
      statusLabel: "Not tracking",
      isRunning: false,
      projects: [],
    });
  });

  it("reports tracking without a name when running has no project", () => {
    const model = buildTrayMenuModel({
      running: { projectId: null },
      elapsedMs: 5 * 60_000,
      projects: [],
    });
    expect(model.statusLabel).toBe("Tracking — 5m");
    expect(model.isRunning).toBe(true);
  });

  it("copies projects to bare {id,name}, dropping extra fields", () => {
    const model = buildTrayMenuModel({
      running: null,
      elapsedMs: 0,
      projects: [
        { id: "a", name: "Alpha", color: "red" } as unknown as {
          id: string;
          name: string;
        },
      ],
    });
    expect(model.projects).toEqual([{ id: "a", name: "Alpha" }]);
  });
});

describe("pushTrayMenuIfChanged", () => {
  const model: TrayMenuModel = {
    statusLabel: "Not tracking",
    isRunning: false,
    projects: [],
  };

  it("pushes and records the serialisation on first call", () => {
    const ref = { current: null as string | null };
    const push = vi.fn();
    const pushed = pushTrayMenuIfChanged(model, ref, push);
    expect(pushed).toBe(true);
    expect(push).toHaveBeenCalledWith(model);
    expect(ref.current).toBe(JSON.stringify(model));
  });

  it("skips the push when the model is unchanged", () => {
    const ref = { current: JSON.stringify(model) };
    const push = vi.fn();
    const pushed = pushTrayMenuIfChanged(model, ref, push);
    expect(pushed).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });

  it("pushes again once the model changes", () => {
    const ref = { current: null as string | null };
    const push = vi.fn();
    pushTrayMenuIfChanged(model, ref, push);
    const next: TrayMenuModel = {
      ...model,
      statusLabel: "Tracking — 1m",
      isRunning: true,
    };
    const pushed = pushTrayMenuIfChanged(next, ref, push);
    expect(pushed).toBe(true);
    expect(push).toHaveBeenLastCalledWith(next);
  });
});
