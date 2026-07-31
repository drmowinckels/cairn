import type { ReactNode } from "react";
import { Empty } from "../../lib/components";
import { Icon } from "../../lib/icon";
import { cbColor } from "../../lib/colorblind";
import { useColorblindEnabled } from "../../lib/use-colorblind";
import { fmtClockFromIso, fmtHm } from "../../lib/time";
import { ROUNDING_OFF, roundMinutes, type Rounding } from "../../lib/rounding";
import type { Project } from "../../lib/types";

export interface RecentEntry {
  id: string;
  projectId: string | null;
  description: string;
  startedAt: string;
  endedAt: string | null;
  source: string;
  /** Label of the linked connector task (#110), when the entry is attributed
   *  to a remote task. Shown as a non-interactive chip — the row itself is the
   *  edit button, so the deep-link lives in the editor, not here. */
  remoteTaskLabel?: string | null;
  /** Number of the invoice this entry was billed on (#287), when billing is
   *  enabled and the entry has been invoiced. A non-interactive chip so the
   *  user sees the time is already on an invoice before editing it. */
  billedInvoiceNumber?: string | null;
}

interface Props {
  entries: RecentEntry[];
  projectsById: Record<string, Project | undefined>;
  onEdit?: (id: string) => void;
  emptyAction?: ReactNode;
  rounding?: Rounding;
  /** Whether this list is showing today (vs a navigated past day) — only
   *  affects the empty-state wording. Defaults to today. */
  emptyToday?: boolean;
}

const DEFAULT_DOT = "var(--ink-faint)";

export function RecentList({
  entries,
  projectsById,
  onEdit,
  emptyAction,
  rounding = ROUNDING_OFF,
  emptyToday = true,
}: Props) {
  const cbEnabled = useColorblindEnabled();
  if (entries.length === 0) {
    return (
      <Empty
        title={emptyToday ? "No entries yet today" : "No entries this day"}
        body={
          emptyToday
            ? "Start a timer or let a rule catch what you're doing."
            : "Nothing was logged on this day."
        }
        action={emptyAction}
      />
    );
  }
  return (
    <ul className="entries">
      {entries.map((e) => {
        const project = e.projectId ? projectsById[e.projectId] : undefined;
        const color = project ? cbColor(project.color, cbEnabled) : DEFAULT_DOT;
        const projectName = project?.name ?? "No project";
        const description = e.description || "(no description)";
        const duration = roundMinutes(
          durationMinutes(e.startedAt, e.endedAt),
          rounding,
        );
        const sourceMeta = sourceFor(e.source);
        const row = (
          <>
            <span className="entry-time">{fmtClockFromIso(e.startedAt)}</span>
            <span
              className="proj-dot"
              style={{ background: color }}
              aria-hidden="true"
            />
            <span className="entry-main">
              <span className="entry-proj">{projectName}</span>
              <span className="entry-task">{description}</span>
              {e.remoteTaskLabel && (
                <span className="entry-remote">
                  <Icon name="globe" size={10} />
                  {e.remoteTaskLabel}
                </span>
              )}
              {e.billedInvoiceNumber && (
                <span
                  className="entry-billed"
                  aria-label={`Billed on ${e.billedInvoiceNumber}`}
                >
                  <Icon name="reports" size={10} />
                  {e.billedInvoiceNumber}
                </span>
              )}
            </span>
            <span className="entry-dur">{fmtHm(duration)}</span>
            <span
              className="entry-src"
              aria-label={`source: ${sourceMeta.label}`}
            >
              {sourceMeta.icon}
            </span>
          </>
        );
        return (
          <li key={e.id} className="entry">
            {onEdit ? (
              <button
                type="button"
                className="entry-btn"
                onClick={() => onEdit(e.id)}
                aria-label={`Edit entry: ${projectName} — ${description}`}
              >
                {row}
              </button>
            ) : (
              row
            )}
          </li>
        );
      })}
    </ul>
  );
}

interface SourceMeta {
  label: string;
  icon: ReactNode;
}

function sourceFor(source: string): SourceMeta {
  if (source.startsWith("rule")) {
    return {
      label: "rule",
      icon: <Icon name="sparkle" size={10} />,
    };
  }
  if (source === "calendar") {
    return {
      label: "calendar",
      icon: <Icon name="calendar" size={10} />,
    };
  }
  return { label: "manual", icon: <Icon name="edit" size={10} /> };
}

function durationMinutes(startedAt: string, endedAt: string | null): number {
  // BackendEntry timestamps come from chrono's RFC3339 — never NaN.
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : Date.now();
  return Math.max(0, Math.round((end - start) / 60_000));
}
