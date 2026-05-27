import { useEffect, useState } from "react";
import { ErrorBoundary } from "../../error-boundary";
import { Icon } from "../../lib/icon";
import { Kbd, LocalBadge } from "../../lib/components";
import { useA11yPrefs } from "../../lib/use-a11y-prefs";
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
  const [showIdleModal, setShowIdleModal] = useState(false);
  const [addEntryRequest, setAddEntryRequest] = useState(0);
  const a11y = useA11yPrefs();

  const requestAddEntry = () => {
    setView("today");
    setAddEntryRequest((n) => n + 1);
  };

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
          <CairnMark />
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
            onClick={requestAddEntry}
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

      <div className="pop-body" role="tabpanel" tabIndex={0}>
        {view === "today" && (
          <ErrorBoundary area="Today">
            <TodayView
              density={density}
              layoutVariant={layoutVariant}
              onOpenRule={openRule}
              showIdleModal={showIdleModal}
              setShowIdleModal={setShowIdleModal}
              detectionPrompts={a11y.detectionPrompts}
              announce={a11y.announce}
              addEntryRequest={addEntryRequest}
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
              ambiguityDefault={a11y.ambiguityDefault}
            />
          </ErrorBoundary>
        )}
        {view === "settings" && (
          <ErrorBoundary area="Settings">
            <SettingsView density={density} a11y={a11y} />
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

function CairnMark() {
  return (
    <svg
      className="brand-mark"
      width="16"
      height="18"
      viewBox="0 0 16 18"
      aria-hidden="true"
      focusable="false"
    >
      <path
        className="stone stone--base"
        d="M1.4 14.6 C0.8 13.4 1.1 12.2 2.4 11.7 C4.8 10.8 9.4 10.6 12.6 11.5 C14.2 11.9 14.9 12.9 14.6 14.1 C14.2 15.5 12.5 16.6 9.6 16.9 C6.4 17.3 3.3 16.7 1.9 15.6 C1.7 15.4 1.5 15.0 1.4 14.6 Z"
      />
      <path
        className="stone stone--mid"
        d="M3.5 9.8 C3.2 8.9 3.7 8.0 5.0 7.6 C6.9 7.0 9.7 7.1 11.2 7.7 C12.2 8.1 12.5 8.9 12.0 9.7 C11.4 10.7 9.7 11.3 7.5 11.3 C5.5 11.3 4.0 10.8 3.5 9.8 Z"
      />
      <path
        className="stone stone--top"
        d="M5.6 5.2 C5.4 4.4 6.1 3.7 7.4 3.5 C8.6 3.3 9.9 3.6 10.3 4.3 C10.7 5.0 10.1 5.8 8.7 6.0 C7.3 6.2 5.9 6.0 5.6 5.2 Z"
      />
    </svg>
  );
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
