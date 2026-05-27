import type { ReactNode } from "react";
import { Empty } from "../../lib/components";
import { Icon } from "../../lib/icon";
import { fmtClockFromIso, fmtHm } from "../../lib/time";
import type { Project } from "../../lib/types";

export interface RecentEntry {
  id: string;
  projectId: string | null;
  description: string;
  startedAt: string;
  endedAt: string | null;
  source: string;
}

interface Props {
  entries: RecentEntry[];
  projectsById: Record<string, Project | undefined>;
  onEdit?: (id: string) => void;
  emptyAction?: ReactNode;
}

const DEFAULT_DOT = "var(--ink-faint)";

export function RecentList({ entries, projectsById, onEdit, emptyAction }: Props) {
  if (entries.length === 0) {
    return (
      <Empty
        title="No entries yet today"
        body="Start a timer or let a rule catch what you're doing."
        action={emptyAction}
      />
    );
  }
  return (
    <ul className="entries">
      {entries.map((e) => {
        const project = e.projectId ? projectsById[e.projectId] : undefined;
        const color = project?.color ?? DEFAULT_DOT;
        const duration = durationMinutes(e.startedAt, e.endedAt);
        const sourceMeta = sourceFor(e.source);
        const row = (
          <>
            <span className="entry-time">{fmtClockFromIso(e.startedAt)}</span>
            <span
              className="proj-dot"
              style={{ background: color }}
              aria-hidden="true"
            />
            <span className="entry-task">{e.description || "(no description)"}</span>
            <span className="entry-dur">{fmtHm(duration)}</span>
            <span className="entry-src" aria-label={`source: ${sourceMeta.label}`}>
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
                aria-label={`Edit entry: ${e.description || "(no description)"}`}
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
  return { label: "manual", icon: null };
}

function durationMinutes(startedAt: string, endedAt: string | null): number {
  // BackendEntry timestamps come from chrono's RFC3339 — never NaN.
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : Date.now();
  return Math.max(0, Math.round((end - start) / 60_000));
}
