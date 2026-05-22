import { useEffect, useState } from "react";
import { ErrorBoundary } from "../../error-boundary";
import { Icon } from "../../lib/icon";
import { Kbd, LocalBadge } from "../../lib/components";
import type {
  Density,
  LayoutVariant,
  RulesComplexity,
  Theme,
  View,
} from "../../lib/types";
import { TodayView } from "../today";
import { ReportsView } from "../reports";
import { RulesView } from "../rules";
import { SettingsView } from "../settings";

interface Props {
  initialView?: View;
  density?: Density;
  layoutVariant?: LayoutVariant;
  ruleComplexity?: RulesComplexity;
  theme?: Theme | "system";
}

export function Popover({
  initialView = "today",
  density = "comfy",
  layoutVariant = "default",
  ruleComplexity = "medium",
  theme = "system",
}: Props) {
  const [view, setView] = useState<View>(initialView);
  const [openRuleId, setOpenRuleId] = useState<string | null>(null);
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);
  const [showIdleModal, setShowIdleModal] = useState(false);

  useEffect(() => {
    if (theme === "system") {
      document.body.removeAttribute("data-theme");
    } else {
      document.body.dataset.theme = theme;
    }
  }, [theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.key === "1") setView("today");
      if (e.key === "2") setView("reports");
      if (e.key === "3") setView("rules");
      if (e.key === "4") setView("settings");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openRule = (id: string) => {
    setOpenRuleId(id);
    setView("rules");
  };

  return (
    <div
      className="pop"
      data-density={density}
      role="dialog"
      aria-label="Cairn time tracker"
    >
      <header className="pop-head">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">
            <span className="mid" />
          </span>
          Cairn
        </span>
        <LocalBadge />
        <span className="spacer" />
        <div className="pop-head-actions">
          <button className="icon-btn" aria-label="Search" title="Search (⌘K)">
            <Icon name="search" />
          </button>
          <button
            className="icon-btn"
            aria-label="Add manual entry"
            title="Add entry"
          >
            <Icon name="plus" />
          </button>
        </div>
      </header>

      <nav className="pop-nav" role="tablist" aria-label="Cairn views">
        <NavTab view="today" current={view} onSelect={setView} icon="today" label="Today" />
        <NavTab view="reports" current={view} onSelect={setView} icon="reports" label="Reports" />
        <NavTab view="rules" current={view} onSelect={setView} icon="rules" label="Rules" />
        <NavTab view="settings" current={view} onSelect={setView} icon="settings" label="Settings" />
        <span className="nav-spacer" />
        <span className="nav-meta">⌃⌥T</span>
      </nav>

      <div className="pop-body" role="tabpanel">
        {view === "today" && (
          <ErrorBoundary area="Today">
            <TodayView
              density={density}
              layoutVariant={layoutVariant}
              onOpenRule={openRule}
              suggestionDismissed={suggestionDismissed}
              setSuggestionDismissed={setSuggestionDismissed}
              showIdleModal={showIdleModal}
              setShowIdleModal={setShowIdleModal}
            />
          </ErrorBoundary>
        )}
        {view === "reports" && (
          <ErrorBoundary area="Reports">
            <ReportsView density={density} />
          </ErrorBoundary>
        )}
        {view === "rules" && (
          <ErrorBoundary area="Rules">
            <RulesView
              complexity={ruleComplexity}
              openRuleId={openRuleId}
              onOpenRule={setOpenRuleId}
              density={density}
            />
          </ErrorBoundary>
        )}
        {view === "settings" && (
          <ErrorBoundary area="Settings">
            <SettingsView density={density} />
          </ErrorBoundary>
        )}
      </div>

      <footer className="pop-foot">
        <span className="foot-left">
          <Icon name="check" size={11} /> 4h 12m today
          <span className="foot-sep" />
          <Icon name="sparkle" size={11} /> 3 rules active
        </span>
        <span className="foot-right">
          <span>
            <Kbd>⌃</Kbd>
            <Kbd>⌥</Kbd>
            <Kbd>␣</Kbd> stop
          </span>
        </span>
      </footer>
    </div>
  );
}

interface NavTabProps {
  view: View;
  current: View;
  onSelect: (v: View) => void;
  icon: "today" | "reports" | "rules" | "settings";
  label: string;
}

function NavTab({ view, current, onSelect, icon, label }: NavTabProps) {
  const active = view === current;
  return (
    <button
      role="tab"
      aria-selected={active}
      className={`pop-nav-btn${active ? " is-on" : ""}`}
      onClick={() => onSelect(view)}
    >
      <Icon name={icon} size={13} /> {label}
    </button>
  );
}
