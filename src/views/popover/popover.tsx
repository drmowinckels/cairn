import { useEffect, useMemo, useRef, useState } from "react";
import { ErrorBoundary } from "../../error-boundary";
import { Icon } from "../../lib/icon";
import { Kbd, LocalBadge } from "../../lib/components";
import { CaptureBanner } from "../../lib/capture-banner";
import { useA11yPrefs } from "../../lib/use-a11y-prefs";
import { AnnouncerProvider, useAnnounce } from "../../lib/use-announce";
import { useSignalCapture } from "../../lib/use-signal-capture";
import { useOnboarding } from "../../lib/use-onboarding";
import { usePalette } from "../../lib/use-palette";
import { usePopoverSize } from "../../lib/use-popover-size";
import { useTrayDetail } from "../../lib/use-tray-detail";
import { useRoundingPrefs } from "../../lib/use-rounding-prefs";
import { useWorkingHours } from "../../lib/use-working-hours";
import { useTaskSwitchPrefs } from "../../lib/use-task-switch-prefs";
import { useTimer } from "../../lib/use-timer";
import { useProjects } from "../../lib/use-projects";
import { useRules } from "../../lib/use-rules";
import { revealDataFolder, setTrayTitle, updateTrayMenu } from "../../lib/ipc";
import { formatTrayTitle } from "../../lib/tray-title";
import { buildTrayMenuModel, pushTrayMenuIfChanged } from "../../lib/tray-menu";
import { useTrayListeners } from "../../lib/use-tray-listeners";
import {
  usePaletteShortcut,
  useToggleTimerShortcut,
} from "../../lib/use-shortcut-listeners";
import type {
  Density,
  LayoutVariant,
  RulesComplexity,
  View,
} from "../../lib/types";
import { TodayView } from "../today";
import { ReportsView } from "../reports";
import { RulesView } from "../rules";
import { DataView } from "../data";
import { SettingsView, type SettingsSectionId } from "../settings";
import { OnboardingView } from "../onboarding";
import { CommandPalette, type PaletteContext } from "../palette/palette";

interface Props {
  initialView?: View;
  density?: Density;
  layoutVariant?: LayoutVariant;
  ruleComplexity?: RulesComplexity;
}

export function Popover({
  initialView = "today",
  density = "comfy",
  layoutVariant = "default",
  ruleComplexity = "medium",
}: Props) {
  const a11y = useA11yPrefs();
  return (
    <AnnouncerProvider enabled={a11y.announce}>
      <PopoverShell
        initialView={initialView}
        density={density}
        layoutVariant={layoutVariant}
        ruleComplexity={ruleComplexity}
        a11y={a11y}
      />
    </AnnouncerProvider>
  );
}

interface ShellProps extends Required<Pick<Props, "initialView" | "density" | "layoutVariant" | "ruleComplexity">> {
  a11y: ReturnType<typeof useA11yPrefs>;
}

function PopoverShell({
  initialView,
  density,
  layoutVariant,
  ruleComplexity,
  a11y,
}: ShellProps) {
  const [view, setView] = useState<View>(initialView);
  const [openRuleId, setOpenRuleId] = useState<string | null>(null);
  const [addEntryRequest, setAddEntryRequest] = useState(0);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSectionId | null>(null);
  const capture = useSignalCapture();
  const onboarding = useOnboarding();
  const announce = useAnnounce();
  const popoverSize = usePopoverSize();
  const trayDetail = useTrayDetail();
  const rounding = useRoundingPrefs();
  const workingHours = useWorkingHours();
  const taskSwitch = useTaskSwitchPrefs();

  // Command-palette wiring (#32). The palette needs read access to the
  // live timer / projects / rules and a handful of actions; instantiate
  // the hooks here so the popover owns the context object. The views
  // keep their own hook instances — all of them are backed by the same
  // SQLite source of truth and resync on the snapshot stream, so a
  // palette action surfaces in the open view within the refresh window.
  const palette = usePalette();
  const paletteTimer = useTimer();
  const { projects: paletteProjects } = useProjects();
  const paletteRules = useRules({ defaultAmbiguity: a11y.ambiguityDefault });

  useToggleTimerShortcut({ announce });
  usePaletteShortcut({ onOpen: palette.requestOpen });
  useTrayListeners({ announce });

  // Mirror the tracked project into the menu-bar tray title when the
  // user enables it (#: tray current-project info). The popover webview
  // stays alive while hidden, so it keeps the title current as the timer
  // changes; pushing "" clears it when the feature is off.
  const running = paletteTimer.running;
  const lastTrayTitleRef = useRef<string | null>(null);
  useEffect(() => {
    const projectName = running?.projectId
      ? (paletteProjects.find((p) => p.id === running.projectId)?.name ?? null)
      : null;
    const title = formatTrayTitle(trayDetail.enabled, projectName, Boolean(running));
    // `running` gets a fresh object every ~2s snapshot refresh even when
    // unchanged; only push when the computed title actually changed.
    if (title === lastTrayTitleRef.current) return;
    lastTrayTitleRef.current = title;
    void setTrayTitle(title);
  }, [trayDetail.enabled, running, paletteProjects]);

  // Keep the tray right-click menu in sync with live state (#104): the
  // status line, whether "Stop tracking" shows, and the quick-start
  // project list. `elapsedMs` ticks every second, so quantise to whole
  // minutes — that's the granularity the status line renders — and only
  // push when the serialised model actually changes, so the native menu
  // isn't rebuilt 60×/minute.
  const elapsedMinutes = Math.floor(paletteTimer.elapsedMs / 60_000);
  const lastTrayMenuRef = useRef<string | null>(null);
  useEffect(() => {
    const model = buildTrayMenuModel({
      running,
      elapsedMs: elapsedMinutes * 60_000,
      projects: paletteProjects,
    });
    pushTrayMenuIfChanged(model, lastTrayMenuRef, (m) => void updateTrayMenu(m));
  }, [running, paletteProjects, elapsedMinutes]);

  const openSettingsSection = (section: SettingsSectionId) => {
    setView("settings");
    setSettingsSection(section);
  };

  const paletteContext: PaletteContext = useMemo(
    () => ({
      view,
      running: paletteTimer.running
        ? {
            id: paletteTimer.running.id,
            projectId: paletteTimer.running.projectId,
          }
        : null,
      projects: paletteProjects,
      rules: paletteRules.rules,
      setView,
      openSettingsSection,
      startTimer: async (projectId) => {
        await paletteTimer.start({ projectId, description: "" });
      },
      stopTimer: async () => {
        await paletteTimer.stop();
      },
      switchProject: (projectId) => paletteTimer.update({ projectId }),
      toggleRule: (ruleId, next) => paletteRules.update(ruleId, { enabled: next }),
      revealDataFolder: () => revealDataFolder(),
    }),
    [view, paletteTimer, paletteProjects, paletteRules],
  );

  const requestAddEntry = () => {
    setView("today");
    setAddEntryRequest((n) => n + 1);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      )
        return;
      if (e.key === "1") setView("today");
      if (e.key === "2") setView("reports");
      if (e.key === "3") setView("rules");
      if (e.key === "4") setView("data");
      if (e.key === "5") setView("settings");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openRule = (id: string) => {
    setOpenRuleId(id);
    setView("rules");
  };

  if (onboarding.status === "needs-onboarding") {
    return (
      <AnnouncerProvider enabled={a11y.announce}>
        <div
          className="pop"
          data-density={density}
          data-onboarding="true"
          role="dialog"
          aria-label="Cairn first-run onboarding"
        >
          <ErrorBoundary area="Onboarding">
            <OnboardingView
              onComplete={async () => {
                await onboarding.complete();
              }}
            />
          </ErrorBoundary>
        </div>
      </AnnouncerProvider>
    );
  }

  return (
    <div
      className="pop"
      data-density={density}
      role="dialog"
      aria-label="Cairn time tracker"
    >
      <header className="pop-head">
        {/* The title + the gap are the window drag handle (#100); the
            action buttons stay clickable since the attribute is only on
            these non-interactive elements. */}
        <span className="brand" data-tauri-drag-region>
          <CairnMark />
          Cairn
        </span>
        <LocalBadge />
        <span className="spacer" data-tauri-drag-region />
        <div className="pop-head-actions">
          <button
            className="icon-btn"
            aria-label="Search"
            title="Search (⌘K)"
            onClick={palette.requestOpen}
          >
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
        <NavTab view="data" current={view} onSelect={setView} icon="folder" label="Data" />
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
              detectionPrompts={a11y.detectionPrompts}
              announce={a11y.announce}
              addEntryRequest={addEntryRequest}
              workingHours={workingHours.workingHours}
              taskSwitch={taskSwitch.prefs}
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
        {view === "data" && (
          <ErrorBoundary area="Data">
            <DataView density={density} />
          </ErrorBoundary>
        )}
        {view === "settings" && (
          <ErrorBoundary area="Settings">
            <SettingsView
              density={density}
              a11y={a11y}
              capture={capture}
              scrollToSection={settingsSection}
              popoverSize={popoverSize}
              trayDetail={trayDetail}
              rounding={rounding}
              workingHours={workingHours}
              taskSwitch={taskSwitch}
              onRerunOnboarding={async () => {
                await onboarding.reset();
              }}
            />
          </ErrorBoundary>
        )}
      </div>

      <CaptureBanner
        status={capture.status}
        onStop={() => {
          void capture.stop();
        }}
      />

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

      <CommandPalette
        open={palette.open}
        onClose={palette.close}
        context={paletteContext}
      />
    </div>
  );
}

interface NavTabProps {
  view: View;
  current: View;
  onSelect: (v: View) => void;
  icon: "today" | "reports" | "rules" | "folder" | "settings";
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
