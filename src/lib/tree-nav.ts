// Pure WAI-ARIA tree-view keyboard navigation (#147). Kept DOM-free so
// the roving-focus + expand/collapse logic is unit-testable in isolation;
// `data-tree.tsx` wires the result to focus and React state.
//
// The Cairn data tree has two treeitem levels — clients (level 1, never
// collapsible) and projects (level 2, collapsible to reveal tasks). Tasks
// are interactive content inside an expanded project, not treeitems, so
// they never enter the roving set.

export interface TreeNode {
  /** Stable id, also written to `data-tree-id` in the DOM. */
  id: string;
  /** 1 = client, 2 = project. */
  level: number;
  /** Parent treeitem id, or null at the root level. */
  parentId: string | null;
  /** Whether the node can be expanded/collapsed (projects can). */
  expandable: boolean;
}

export interface TreeNavState {
  /** The treeitem that currently holds focus (roving tabindex). */
  activeId: string;
  /** Set of expanded (project) node ids. */
  expanded: Set<string>;
}

/** Keys this module knows how to handle; others are left to the browser. */
export const TREE_NAV_KEYS: ReadonlySet<string> = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "Enter",
  " ",
]);

/**
 * Apply one keystroke to the tree state, returning the next state. Pure:
 * the `expanded` Set reference is preserved when expansion is unchanged
 * (so React can skip a re-render), and the whole state is returned
 * untouched for no-op moves (e.g. ArrowUp on the first node).
 *
 * `nodes` is the flat list of *visible* treeitems in DOM order. In this
 * tree every client and project is always visible, so the list does not
 * depend on `expanded`.
 */
export function treeNavigate(
  nodes: TreeNode[],
  state: TreeNavState,
  key: string,
): TreeNavState {
  const idx = nodes.findIndex((n) => n.id === state.activeId);
  if (idx === -1) return state;
  const node = nodes[idx];

  const moveTo = (i: number): TreeNavState => {
    const clamped = Math.max(0, Math.min(nodes.length - 1, i));
    return clamped === idx ? state : { ...state, activeId: nodes[clamped].id };
  };

  // Only ever called when the open-state actually flips (the ArrowRight/
  // ArrowLeft/Enter arms below guard on the current state first), so it
  // always produces a fresh Set.
  const withExpanded = (id: string, open: boolean): TreeNavState => {
    const next = new Set(state.expanded);
    if (open) next.add(id);
    else next.delete(id);
    return { ...state, expanded: next };
  };

  switch (key) {
    case "ArrowDown":
      return moveTo(idx + 1);
    case "ArrowUp":
      return moveTo(idx - 1);
    case "Home":
      return moveTo(0);
    case "End":
      return moveTo(nodes.length - 1);
    case "ArrowRight": {
      if (node.expandable && !state.expanded.has(node.id)) {
        return withExpanded(node.id, true);
      }
      // Already expanded (or not expandable): move to the first child.
      const childIdx = nodes.findIndex((n) => n.parentId === node.id);
      return childIdx === -1 ? state : moveTo(childIdx);
    }
    case "ArrowLeft": {
      if (node.expandable && state.expanded.has(node.id)) {
        return withExpanded(node.id, false);
      }
      // Collapsed or leaf: move to the parent.
      if (node.parentId !== null) {
        const parentIdx = nodes.findIndex((n) => n.id === node.parentId);
        if (parentIdx !== -1) return moveTo(parentIdx);
      }
      return state;
    }
    case "Enter":
    case " ":
      if (node.expandable) {
        return withExpanded(node.id, !state.expanded.has(node.id));
      }
      return state;
    default:
      return state;
  }
}
