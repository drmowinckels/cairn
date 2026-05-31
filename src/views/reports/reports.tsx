import { useMemo, useState } from "react";
import { Empty, ErrorBanner, Mono } from "../../lib/components";
import { cbColor } from "../../lib/colorblind";
import { useColorblindEnabled } from "../../lib/use-colorblind";
import { buildWeekSummary } from "../../lib/summary";
import { useBackup } from "../../lib/use-backup";
import { useProjects } from "../../lib/use-projects";
import { useReportSummary } from "../../lib/use-report-summary";
import { useRoundingPrefs } from "../../lib/use-rounding-prefs";
import { isRoundingActive, roundingLabel } from "../../lib/rounding";
import {
  buildStackedDays,
  computeDelta,
  deltaComparisonLabel,
  formatRangeLabel,
  percentOf,
  rangeTitle,
  secondsToHours,
  weekdayLabel,
} from "../../lib/report-math";
import type { ReportRange } from "../../lib/ipc";
import type { Density, Project, WeekDay } from "../../lib/types";

interface Props {
  density: Density;
}

const RANGES: ReportRange[] = ["day", "week", "month"];

const RANGE_LABEL: Record<ReportRange, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
};

export function ReportsView({ density }: Props) {
  const backup = useBackup();
  const { projects } = useProjects();
  const projectsById = useMemo<Record<string, Project>>(
    () => Object.fromEntries(projects.map((p) => [p.id, p])),
    [projects],
  );
  const [range, setRange] = useState<ReportRange>("week");
  const [copied, setCopied] = useState(false);
  const { rounding } = useRoundingPrefs();
  const { data, loading, error, refresh } = useReportSummary(range, {
    rounding,
  });

  const stackedDays = useMemo(
    () => (data ? buildStackedDays(data) : []),
    [data],
  );
  const maxDaySeconds = useMemo(
    () => stackedDays.reduce((m, d) => Math.max(m, d.totalSeconds), 8 * 3600),
    [stackedDays],
  );
  const totalSeconds = data?.totalSeconds ?? 0;
  const totalHours = secondsToHours(totalSeconds);
  const delta = computeDelta(totalSeconds, data?.prevTotalSeconds ?? 0);

  const cbEnabled = useColorblindEnabled();
  const projectColor = (projectId: string | null): string => {
    if (!projectId) return "var(--ink-faint)";
    const raw = projectsById[projectId]?.color;
    if (!raw) return "var(--ink-faint)";
    return cbColor(raw, cbEnabled);
  };
  const projectName = (projectId: string | null): string => {
    if (!projectId) return "No project";
    return projectsById[projectId]?.name ?? projectId;
  };

  const onCopySummary = async () => {
    // The button is `disabled={!hasData}` and `hasData` is false whenever
    // `data` is null, so this handler runs only when `data` is non-null.
    const summaryData = data!;
    const week: WeekDay[] = summaryData.byDay.map((d) => {
      const segments: Array<[string, number]> = d.byProject.map((s) => [
        s.projectId ?? "_none",
        secondsToHours(s.seconds),
      ]);
      const hours = segments.reduce((a, [, h]) => a + h, 0);
      return {
        day: weekdayLabel(d.date) || d.date,
        hours,
        segments,
      };
    });
    const summary = buildWeekSummary({
      weekLabel: formatRangeLabel(summaryData),
      week,
      projectsById: {
        ...projectsById,
        _none: {
          id: "_none",
          name: "No project",
          clientId: null,
          color: "#999",
          archived: false,
        },
      },
    });
    try {
      await navigator.clipboard.writeText(summary);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error("clipboard write failed", e);
    }
  };

  const hasData = totalSeconds > 0;
  const honestyTotal =
    (data?.bySource.rule ?? 0) +
    (data?.bySource.calendar ?? 0) +
    (data?.bySource.manual ?? 0);

  return (
    <div className="view view-reports" data-density={density}>
      <header className="view-head">
        <div>
          <h2 className="view-title">{rangeTitle(range)}</h2>
          <p className="view-sub">
            {data ? formatRangeLabel(data) : ""}
            {isRoundingActive(rounding) && (
              <span className="rep-rounding-badge" title="Durations rounded">
                {" · "}rounded to {roundingLabel(rounding.intervalMinutes)}
              </span>
            )}
          </p>
        </div>
        <div className="seg" role="radiogroup" aria-label="Period">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={r === range}
              aria-label={RANGE_LABEL[r]}
              className={`seg-btn${r === range ? " is-on" : ""}`}
              onClick={() => setRange(r)}
            >
              {RANGE_LABEL[r]}
            </button>
          ))}
        </div>
      </header>

      {error && <ErrorBanner message={error} onRetry={refresh} />}

      {!loading && !hasData && !error && (
        <Empty
          title="No hours tracked"
          body="Once you start logging, you'll see daily totals and a breakdown by project here."
        />
      )}

      <section className="totals" aria-label="Headline totals">
        <div className="total">
          <span className="total-num">
            <Mono>{totalHours.toFixed(1)}</Mono>h
          </span>
          <span className="total-lbl">tracked</span>
        </div>
        <div className="total">
          <span
            className={`total-num rep-delta rep-delta--${delta.kind}`}
            aria-label={`Compared to ${deltaComparisonLabel(range)}`}
          >
            {delta.kind === "up" && (
              <span aria-hidden="true" className="rep-delta-arrow">
                ▲
              </span>
            )}
            {delta.kind === "down" && (
              <span aria-hidden="true" className="rep-delta-arrow">
                ▼
              </span>
            )}
            {delta.kind === "flat" && (
              <span aria-hidden="true" className="rep-delta-arrow">
                ◆
              </span>
            )}
            {delta.kind === "none" ? (
              <Mono>—</Mono>
            ) : (
              <>
                <Mono>{Math.abs(delta.percent).toFixed(0)}</Mono>%
              </>
            )}
          </span>
          <span className="total-lbl">{deltaComparisonLabel(range)}</span>
        </div>
        <div className="total">
          <span className="total-num">
            <Mono>{data?.byProject.length ?? 0}</Mono>
          </span>
          <span className="total-lbl">projects</span>
        </div>
      </section>

      <section className="chart" aria-label="Hours per day">
        <div className="chart-bars">
          {stackedDays.map((d) => {
            const heightPct = (d.totalSeconds / maxDaySeconds) * 100;
            const hours = secondsToHours(d.totalSeconds);
            return (
              <div
                key={d.isoDate}
                className={`bar-col${d.isToday ? " is-today" : ""}${d.isFuture ? " is-future" : ""}`}
                aria-label={`${d.weekday}: ${hours.toFixed(1)} hours${d.isToday ? " (today)" : ""}`}
              >
                <div
                  className="bar-stack"
                  style={{ height: `${heightPct}%` }}
                >
                  {d.segments.map((s) => (
                    <div
                      key={s.projectId ?? "_none"}
                      className="bar-seg"
                      style={{
                        flex: s.seconds,
                        background: projectColor(s.projectId),
                      }}
                      title={`${projectName(s.projectId)}: ${secondsToHours(s.seconds).toFixed(1)}h`}
                    />
                  ))}
                </div>
                <div className="bar-meta">
                  <span className="bar-h">
                    {d.totalSeconds > 0 ? hours.toFixed(1) : "·"}
                  </span>
                  <span className="bar-d">{d.weekday}</span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="breakdown" aria-label="Project breakdown">
        <div className="sect-label">
          <span>By project</span>
        </div>
        <ul className="bd-list">
          {(data?.byProject ?? []).map((slice) => {
            const hours = secondsToHours(slice.seconds);
            const pct = percentOf(slice.seconds, totalSeconds);
            const color = projectColor(slice.projectId);
            return (
              <li key={slice.projectId ?? "_none"} className="bd-row">
                <span
                  className="proj-dot"
                  style={{ background: color, width: 8, height: 8 }}
                />
                <span className="bd-name">{projectName(slice.projectId)}</span>
                <div className="bd-bar">
                  <div
                    className="bd-bar-fill"
                    style={{ width: `${pct}%`, background: color }}
                  />
                </div>
                <span className="bd-pct">
                  <Mono>{pct.toFixed(0)}</Mono>%
                </span>
                <span className="bd-h">
                  <Mono>{hours.toFixed(1)}</Mono>h
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="honesty" aria-label="Honesty meter">
        <div className="sect-label">
          <span>How this time was logged</span>
        </div>
        <div
          className="honesty-bar"
          role="img"
          aria-label={honestyAriaLabel(data?.bySource, honestyTotal)}
        >
          <span
            className="hon-seg hon-rule"
            style={{ width: `${percentOf(data?.bySource.rule ?? 0, honestyTotal)}%` }}
            data-testid="hon-rule"
          />
          <span
            className="hon-seg hon-cal"
            style={{ width: `${percentOf(data?.bySource.calendar ?? 0, honestyTotal)}%` }}
            data-testid="hon-cal"
          />
          <span
            className="hon-seg hon-manual"
            style={{ width: `${percentOf(data?.bySource.manual ?? 0, honestyTotal)}%` }}
            data-testid="hon-manual"
          />
        </div>
        <ul className="hon-legend">
          <li>
            <span className="hon-key hon-rule" aria-hidden="true" />
            <span>Rule-detected</span>
            <Mono>
              {percentOf(data?.bySource.rule ?? 0, honestyTotal).toFixed(0)}%
            </Mono>
          </li>
          <li>
            <span className="hon-key hon-cal" aria-hidden="true" />
            <span>From calendar</span>
            <Mono>
              {percentOf(data?.bySource.calendar ?? 0, honestyTotal).toFixed(0)}%
            </Mono>
          </li>
          <li>
            <span className="hon-key hon-manual" aria-hidden="true" />
            <span>Manual</span>
            <Mono>
              {percentOf(data?.bySource.manual ?? 0, honestyTotal).toFixed(0)}%
            </Mono>
          </li>
        </ul>
      </section>

      <section className="export-row">
        <button
          type="button"
          className="link-btn"
          onClick={() => backup.exportCsvToFile(rounding)}
        >
          Export CSV
        </button>
        <span className="dot-sep">·</span>
        <button
          type="button"
          className="link-btn"
          onClick={backup.exportBackupToFile}
        >
          Export backup
        </button>
        <span className="dot-sep">·</span>
        <button
          type="button"
          className="link-btn"
          onClick={onCopySummary}
          disabled={!hasData}
        >
          {copied ? "Copied ✓" : "Copy summary"}
        </button>
      </section>
    </div>
  );
}

function honestyAriaLabel(
  bySource: { rule: number; calendar: number; manual: number } | undefined,
  total: number,
): string {
  if (!bySource || total === 0) return "No tracked time yet";
  const rule = percentOf(bySource.rule, total).toFixed(0);
  const cal = percentOf(bySource.calendar, total).toFixed(0);
  const man = percentOf(bySource.manual, total).toFixed(0);
  return `Rule-detected ${rule}%, calendar ${cal}%, manual ${man}%`;
}
