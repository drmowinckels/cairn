import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project, Rule } from "./types";
import {
  adoptStarter,
  isStarterAdopted,
  loadDismissedStarters,
  pendingStarters,
  persistDismissedStarter,
  STARTER_DISMISSED_KEY,
  STARTER_RULES,
} from "./starter-rules";

afterEach(() => {
  window.localStorage.clear();
});

function rule(over: Partial<Rule> = {}): Rule {
  return {
    id: "r1",
    name: "Some rule",
    enabled: true,
    priority: 10,
    when: [{ signal: "ide.folder", op: "contains", value: "cairn" }],
    then: { project: "p1" },
    matchedToday: 0,
    ...over,
  };
}

const meetings = STARTER_RULES.find((s) => s.id === "meetings")!;

describe("STARTER_RULES", () => {
  it("ships meeting + coding starters keyed on app.category", () => {
    expect(STARTER_RULES.map((s) => s.id)).toEqual(["meetings", "coding"]);
    for (const s of STARTER_RULES) {
      expect(s.when.every((c) => c.signal === "app.category")).toBe(true);
      expect(s.project.name).toBeTruthy();
      expect(s.project.color).toMatch(/^#/);
    }
  });
});

describe("isStarterAdopted", () => {
  it("is false when no rule carries the starter's conditions", () => {
    expect(isStarterAdopted(meetings, [rule()])).toBe(false);
  });

  it("is true when a rule already carries every starter condition", () => {
    const adopted = rule({
      when: [{ signal: "app.category", op: "equals", value: "meeting" }],
    });
    expect(isStarterAdopted(meetings, [adopted])).toBe(true);
  });

  it("matches on conditions, not name (a renamed rule still counts)", () => {
    const renamed = rule({
      name: "My meetings",
      when: [{ signal: "app.category", op: "equals", value: "meeting" }],
    });
    expect(isStarterAdopted(meetings, [renamed])).toBe(true);
  });
});

describe("dismissed-starter persistence", () => {
  it("returns [] when nothing has been dismissed", () => {
    expect(loadDismissedStarters()).toEqual([]);
  });

  it("persists and de-duplicates dismissed ids", () => {
    persistDismissedStarter("meetings");
    persistDismissedStarter("meetings");
    persistDismissedStarter("coding");
    expect(loadDismissedStarters().sort()).toEqual(["coding", "meetings"]);
  });

  it("ignores a malformed stored value", () => {
    window.localStorage.setItem(STARTER_DISMISSED_KEY, "not json");
    expect(loadDismissedStarters()).toEqual([]);
  });

  it("ignores valid JSON that isn't a string array", () => {
    window.localStorage.setItem(STARTER_DISMISSED_KEY, '{"x":1}');
    expect(loadDismissedStarters()).toEqual([]);
  });

  it("filters non-string entries out of a stored array", () => {
    window.localStorage.setItem(STARTER_DISMISSED_KEY, '["meetings",3,null]');
    expect(loadDismissedStarters()).toEqual(["meetings"]);
  });
});

describe("pendingStarters", () => {
  it("returns all starters for a fresh user with no rules", () => {
    expect(pendingStarters([], [])).toHaveLength(STARTER_RULES.length);
  });

  it("drops an adopted starter", () => {
    const adopted = rule({
      when: [{ signal: "app.category", op: "equals", value: "meeting" }],
    });
    const pending = pendingStarters([adopted], []);
    expect(pending.find((s) => s.id === "meetings")).toBeUndefined();
    expect(pending.find((s) => s.id === "coding")).toBeTruthy();
  });

  it("drops a dismissed starter", () => {
    const pending = pendingStarters([], ["coding"]);
    expect(pending.find((s) => s.id === "coding")).toBeUndefined();
    expect(pending.find((s) => s.id === "meetings")).toBeTruthy();
  });
});

describe("adoptStarter", () => {
  function project(over: Partial<Project> = {}): Project {
    return {
      id: "p-existing",
      name: "Meetings",
      clientId: null,
      color: "#000",
      archived: false,
      estimateHours: null,
      ...over,
    };
  }

  it("reuses an existing project (case-insensitive) without creating one", async () => {
    const createProject = vi.fn();
    const addFromTemplate = vi.fn().mockResolvedValue("rule-1");
    const err = await adoptStarter(meetings, {
      projects: [project({ name: "meetings" })],
      createProject,
      addFromTemplate,
    });
    expect(err).toBeNull();
    expect(createProject).not.toHaveBeenCalled();
    expect(addFromTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Meetings",
        then: { project: "p-existing" },
      }),
    );
  });

  it("creates the project when none matches, then the rule", async () => {
    const createProject = vi.fn().mockResolvedValue(project({ id: "p-new" }));
    const addFromTemplate = vi.fn().mockResolvedValue("rule-2");
    const err = await adoptStarter(meetings, {
      projects: [],
      createProject,
      addFromTemplate,
    });
    expect(err).toBeNull();
    expect(createProject).toHaveBeenCalledWith({
      name: meetings.project.name,
      color: meetings.project.color,
    });
    expect(addFromTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ then: { project: "p-new" } }),
    );
  });

  it("returns the message when project creation fails", async () => {
    const err = await adoptStarter(meetings, {
      projects: [],
      createProject: vi.fn().mockRejectedValue(new Error("DB locked")),
      addFromTemplate: vi.fn(),
    });
    expect(err).toBe("DB locked");
  });

  it("stringifies a non-Error rejection", async () => {
    const err = await adoptStarter(meetings, {
      projects: [project()],
      createProject: vi.fn(),
      addFromTemplate: vi.fn().mockRejectedValue("nope"),
    });
    expect(err).toBe("nope");
  });
});
