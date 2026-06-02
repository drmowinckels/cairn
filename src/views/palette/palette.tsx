import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon, type IconName } from "../../lib/icon";
import { rank } from "../../lib/fuzzy";
import {
  applyMruOrder,
  createMruStore,
  type MruStore,
} from "../../lib/use-palette";
import type { Project, Rule, View } from "../../lib/types";
import type { SettingsSectionId } from "../settings/settings";

export type SettingsSection = SettingsSectionId;

export interface PaletteCommand {
  id: string;
  /** Human label shown in the palette + matched against the query. */
  label: string;
  /** Optional secondary label rendered to the right (e.g. project name). */
  hint?: string;
  /** Section header rendered above the item, when distinct from the prev row. */
  group: string;
  /** Leading icon. */
  icon: IconName;
  run: () => void | Promise<void>;
}

export interface PaletteContext {
  view: View;
  running: { id: string; projectId: string | null } | null;
  projects: Project[];
  rules: Rule[];
  setView: (view: View) => void;
  openSettingsSection: (section: SettingsSection) => void;
  startTimer: (projectId: string) => void | Promise<void>;
  stopTimer: () => void | Promise<void>;
  switchProject: (projectId: string) => void | Promise<void>;
  toggleRule: (ruleId: string, next: boolean) => void | Promise<void>;
  revealDataFolder: () => void | Promise<void>;
  /** Open the manual-entry modal on the Today view (was the header `+`). */
  addEntry: () => void;
}

/**
 * Pure function: build the full command list from the palette
 * context. Exported so tests can pin the surfaced-commands contract
 * without rendering React.
 *
 * The acceptance criteria (#32) enumerate the surfaced commands:
 * switch project on running timer, start timer per project (when
 * idle), stop running timer, switch view, open settings section,
 * toggle rule, open log file.
 */
export function buildCommands(ctx: PaletteContext): PaletteCommand[] {
  const out: PaletteCommand[] = [];
  const running = ctx.running;

  out.push({
    id: "add-entry",
    label: "Add manual entry",
    hint: "Log time by hand",
    group: "Timer",
    icon: "plus",
    run: () => ctx.addEntry(),
  });

  if (running) {
    for (const p of ctx.projects) {
      if (p.id === running.projectId) continue;
      out.push({
        id: `switch-project:${p.id}`,
        label: `Switch running timer to ${p.name}`,
        group: "Timer",
        icon: "arrow-right",
        run: () => ctx.switchProject(p.id),
      });
    }
    out.push({
      id: "stop-timer",
      label: "Stop running timer",
      group: "Timer",
      icon: "stop",
      run: () => ctx.stopTimer(),
    });
  } else {
    for (const p of ctx.projects) {
      out.push({
        id: `start-project:${p.id}`,
        label: `Start timer for ${p.name}`,
        group: "Timer",
        icon: "play",
        run: () => ctx.startTimer(p.id),
      });
    }
  }

  const VIEWS: Array<{ id: View; label: string; icon: IconName }> = [
    { id: "today", label: "Today", icon: "today" },
    { id: "reports", label: "Reports", icon: "reports" },
    { id: "rules", label: "Rules", icon: "rules" },
    { id: "data", label: "Data", icon: "folder" },
    { id: "settings", label: "Settings", icon: "settings" },
  ];
  for (const v of VIEWS) {
    if (v.id === ctx.view) continue;
    out.push({
      id: `view:${v.id}`,
      label: `Switch view: ${v.label}`,
      group: "Navigation",
      icon: v.icon,
      run: () => ctx.setView(v.id),
    });
  }

  const SECTIONS: Array<{
    id: SettingsSection;
    label: string;
    icon: IconName;
  }> = [
    { id: "privacy", label: "Privacy", icon: "shield" },
    { id: "exclusions", label: "Never track these", icon: "lock" },
    { id: "accessibility", label: "Accessibility", icon: "type" },
    { id: "calendar", label: "Calendar", icon: "calendar" },
    { id: "shortcuts", label: "Shortcuts", icon: "keyboard" },
    { id: "integrations", label: "Integrations", icon: "globe" },
    { id: "about", label: "About", icon: "info" },
  ];
  for (const s of SECTIONS) {
    out.push({
      id: `settings:${s.id}`,
      label: `Open settings: ${s.label}`,
      group: "Settings",
      icon: s.icon,
      run: () => ctx.openSettingsSection(s.id),
    });
  }

  for (const r of ctx.rules) {
    out.push({
      id: `toggle-rule:${r.id}`,
      label: r.enabled ? `Disable rule: ${r.name}` : `Enable rule: ${r.name}`,
      group: "Rules",
      icon: "sparkle",
      run: () => ctx.toggleRule(r.id, !r.enabled),
    });
  }

  out.push({
    id: "open-log-file",
    label: "Open log file",
    hint: "Reveal data folder",
    group: "Data",
    icon: "folder",
    run: () => ctx.revealDataFolder(),
  });

  return out;
}

interface Props {
  open: boolean;
  onClose: () => void;
  context: PaletteContext;
  /** Override for tests. Defaults to `createMruStore()`. */
  mruStore?: MruStore;
}

export function CommandPalette({ open, onClose, context, mruStore }: Props) {
  const titleId = useId();
  const listId = useId();
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(0);

  const store = useMemo(() => mruStore ?? createMruStore(), [mruStore]);
  const allCommands = useMemo(() => buildCommands(context), [context]);

  // Reset query + highlight on each open transition.
  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlightIndex(0);
      const id = window.requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
      return () => window.cancelAnimationFrame(id);
    }
    return undefined;
  }, [open]);

  // When the query is empty, prefer MRU order. Otherwise rank by
  // fuzzy match. Keeping the two paths separate keeps each
  // testable in isolation (see palette.test.tsx + fuzzy.test.ts).
  const visible = useMemo(() => {
    if (query.trim() === "") {
      return applyMruOrder(allCommands, (c) => c.id, store.read());
    }
    return rank(query, allCommands, (c) => `${c.label} ${c.group}`);
  }, [query, allCommands, store]);

  useEffect(() => {
    if (highlightIndex >= visible.length) {
      setHighlightIndex(Math.max(0, visible.length - 1));
    }
  }, [visible.length, highlightIndex]);

  const execute = useCallback(
    (cmd: PaletteCommand) => {
      store.bump(cmd.id);
      onClose();
      // Defer the run so the popover doesn't re-render mid-close —
      // a `setView` inside `run()` would otherwise race with our
      // own focus-return rAF.
      window.requestAnimationFrame(() => {
        void cmd.run();
      });
    },
    [onClose, store],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIndex((i) => Math.min(visible.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Home") {
        e.preventDefault();
        setHighlightIndex(0);
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        setHighlightIndex(Math.max(0, visible.length - 1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const cmd = visible[highlightIndex];
        if (cmd) execute(cmd);
        return;
      }
      if (e.key !== "Tab") return;
      // Focus trap: only the input and the listbox are tabbable, so
      // wrap manually. With one focusable, Tab cycles to itself.
      const root = dialogRef.current;
      if (!root) return;
      const focusables = focusableElements(root);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [execute, highlightIndex, onClose, visible],
  );

  useEffect(() => {
    if (!open) return;
    // Scroll the highlighted row into view as the user arrows
    // through. Using `block:nearest` avoids a jarring center-snap.
    const node = document.getElementById(`${listId}-${highlightIndex}`);
    node?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex, listId, open]);

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className="modal-overlay palette-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      {/* Focus-trapped modal: onKeyDown handles Escape/Tab/arrow nav. The
          dialog role is non-interactive but key handling here is the
          standard modal pattern, not a clickable control. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={dialogRef}
        className="modal palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleKeyDown}
      >
        <header className="palette-head">
          <Icon name="search" size={14} />
          <h2 id={titleId} className="visually-hidden">
            Cairn quick command finder
          </h2>
          <input
            ref={inputRef}
            type="text"
            className="palette-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command…"
            aria-label="Command palette"
            aria-controls={listId}
            aria-activedescendant={
              visible[highlightIndex]
                ? `${listId}-${highlightIndex}`
                : undefined
            }
            autoComplete="off"
            spellCheck={false}
          />
        </header>

        {visible.length === 0 ? (
          <div className="palette-empty" role="status">
            No matching commands.
          </div>
        ) : (
          <ul
            id={listId}
            className="palette-list"
            role="listbox"
            aria-label="Commands"
          >
            {renderGroupedItems(
              visible,
              highlightIndex,
              listId,
              execute,
              setHighlightIndex,
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

function renderGroupedItems(
  items: PaletteCommand[],
  highlight: number,
  listId: string,
  execute: (cmd: PaletteCommand) => void,
  setHighlight: (i: number) => void,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastGroup = "";
  for (let i = 0; i < items.length; i++) {
    const cmd = items[i];
    if (cmd.group !== lastGroup) {
      nodes.push(
        <li
          key={`group-${cmd.group}-${i}`}
          className="palette-group"
          role="presentation"
        >
          {cmd.group}
        </li>,
      );
      lastGroup = cmd.group;
    }
    const active = i === highlight;
    nodes.push(
      // Listbox option: keyboard activation is centralized on the input
      // (aria-activedescendant + Enter in handleKeyDown); the onClick is a
      // pointer affordance, so a per-option key handler is not needed.
      // eslint-disable-next-line jsx-a11y/click-events-have-key-events
      <li
        key={cmd.id}
        id={`${listId}-${i}`}
        role="option"
        aria-selected={active}
        className={`palette-item${active ? " is-active" : ""}`}
        onMouseEnter={() => setHighlight(i)}
        onClick={() => execute(cmd)}
      >
        <Icon name={cmd.icon} size={13} />
        <span className="palette-label">{cmd.label}</span>
        {cmd.hint && <span className="palette-hint">{cmd.hint}</span>}
      </li>,
    );
  }
  return nodes;
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  const selector =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => !el.hasAttribute("aria-hidden") && el.offsetParent !== null,
  );
}
