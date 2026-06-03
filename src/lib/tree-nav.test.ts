import { describe, it, expect } from "vitest";
import {
  TREE_NAV_KEYS,
  treeNavigate,
  type TreeNode,
  type TreeNavState,
} from "./tree-nav";

// client A ─ project A1
//          └ project A2
// client B ─ project B1
const NODES: TreeNode[] = [
  { id: "client:A", level: 1, parentId: null, expandable: false },
  { id: "project:A1", level: 2, parentId: "client:A", expandable: true },
  { id: "project:A2", level: 2, parentId: "client:A", expandable: true },
  { id: "client:B", level: 1, parentId: null, expandable: false },
  { id: "project:B1", level: 2, parentId: "client:B", expandable: true },
];

const at = (activeId: string, expanded: string[] = []): TreeNavState => ({
  activeId,
  expanded: new Set(expanded),
});

const nav = (s: TreeNavState, key: string) => treeNavigate(NODES, s, key);

describe("treeNavigate — vertical movement", () => {
  it("ArrowDown moves to the next visible treeitem", () => {
    expect(nav(at("client:A"), "ArrowDown").activeId).toBe("project:A1");
    expect(nav(at("project:A1"), "ArrowDown").activeId).toBe("project:A2");
    expect(nav(at("project:A2"), "ArrowDown").activeId).toBe("client:B");
  });

  it("ArrowUp moves to the previous treeitem", () => {
    expect(nav(at("project:B1"), "ArrowUp").activeId).toBe("client:B");
    expect(nav(at("client:A"), "ArrowUp").activeId).toBe("client:A"); // clamps
  });

  it("ArrowDown clamps at the last node", () => {
    expect(nav(at("project:B1"), "ArrowDown").activeId).toBe("project:B1");
  });

  it("Home and End jump to the first and last treeitems", () => {
    expect(nav(at("project:A2"), "Home").activeId).toBe("client:A");
    expect(nav(at("client:A"), "End").activeId).toBe("project:B1");
  });

  it("returns the same state object for a no-op move", () => {
    const s = at("client:A");
    expect(nav(s, "ArrowUp")).toBe(s);
  });
});

describe("treeNavigate — ArrowRight", () => {
  it("expands a collapsed project without moving focus", () => {
    const next = nav(at("project:A1"), "ArrowRight");
    expect(next.activeId).toBe("project:A1");
    expect(next.expanded.has("project:A1")).toBe(true);
  });

  it("on an already-expanded project is a no-op (tasks aren't treeitems)", () => {
    const s = at("project:A1", ["project:A1"]);
    expect(nav(s, "ArrowRight")).toBe(s);
  });

  it("on a client moves to its first project child", () => {
    expect(nav(at("client:A"), "ArrowRight").activeId).toBe("project:A1");
    expect(nav(at("client:B"), "ArrowRight").activeId).toBe("project:B1");
  });
});

describe("treeNavigate — ArrowLeft", () => {
  it("collapses an expanded project without moving focus", () => {
    const next = nav(at("project:A1", ["project:A1"]), "ArrowLeft");
    expect(next.activeId).toBe("project:A1");
    expect(next.expanded.has("project:A1")).toBe(false);
  });

  it("on a collapsed project moves to its parent client", () => {
    expect(nav(at("project:A2"), "ArrowLeft").activeId).toBe("client:A");
  });

  it("on a top-level client is a no-op", () => {
    const s = at("client:A");
    expect(nav(s, "ArrowLeft")).toBe(s);
  });
});

describe("treeNavigate — Enter / Space toggle expansion", () => {
  it("Enter toggles a project open then closed", () => {
    const opened = nav(at("project:A1"), "Enter");
    expect(opened.expanded.has("project:A1")).toBe(true);
    const closed = nav(at("project:A1", ["project:A1"]), "Enter");
    expect(closed.expanded.has("project:A1")).toBe(false);
  });

  it("Space behaves like Enter", () => {
    expect(nav(at("project:B1"), " ").expanded.has("project:B1")).toBe(true);
  });

  it("on a non-expandable client is a no-op", () => {
    const s = at("client:A");
    expect(nav(s, "Enter")).toBe(s);
  });

  it("preserves the expanded Set reference when nothing changes", () => {
    const s = at("client:A");
    expect(nav(s, "Enter").expanded).toBe(s.expanded);
  });
});

describe("treeNavigate — guards", () => {
  it("ignores an unknown key", () => {
    const s = at("project:A1");
    expect(nav(s, "x")).toBe(s);
  });

  it("returns state unchanged when the active id is not in the node list", () => {
    const s = at("project:gone");
    expect(nav(s, "ArrowDown")).toBe(s);
  });

  it("TREE_NAV_KEYS covers the handled keys", () => {
    for (const k of [
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "Enter",
      " ",
    ]) {
      expect(TREE_NAV_KEYS.has(k)).toBe(true);
    }
    expect(TREE_NAV_KEYS.has("Tab")).toBe(false);
  });
});
