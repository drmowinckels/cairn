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
  averageUnitLabel,
  buildBuckets,
  chartAxis,
  computeDelta,
  deltaComparisonLabel,
  formatRangeLabel,
  percentOf,
  rangeTitle,
  reportDigest,
  secondsToHours,
  weekdayLabel,
} from "../../lib/report-math";
import type { ReportProjectSlice, ReportRange } from "../../lib/ipc";
import type { Density, Project, WeekDay } from "../../lib/types";

interface Props {
  density: Density;
}

const RANGES: ReportRange[] = ["week", "month", "quarter", "year"];

const RANGE_LABEL: Record<ReportRange, string> = {
  week: "Week",
  month: "Month",
  quarter: "Quarter",
  year: "Year",
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

  const buckets = useMemo(
    () => (data ? buildBuckets(data, range) : []),
    [data, range],
  );
  const digest = useMemo(
    () => (data ? reportDigest(data, buckets, range) : null),
    [data, buckets, range],
  );
  const axis = useMemo(
    () => chartAxis(buckets.reduce((m, b) => Math.max(m, b.totalSeconds), 0)),
    [buckets],
  );
  const axisMaxHours = axis.maxSeconds / 3600;
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
  // A slice groups by local project, else by remote-task project (#110), else
  // the no-project bucket. Its key must be unique across remote slices (which
  // all have a null projectId).
  const sliceKey = (s: ReportProjectSlice): string =>
    s.projectId ?? s.remoteProjectName ?? "_none";
  const sliceName = (s: ReportProjectSlice): string =>
    s.projectId
      ? projectName(s.projectId)
      : (s.remoteProjectName ?? "No project");

  const onCopySummary = async () => {
    // The button is `disabled={!hasData}` and `hasData` is false whenever
    // `data` is null, so this handler runs only when `data` is non-null.
    const summaryData = data!;
    const week: WeekDay[] = summaryData.byDay.map((d) => {
      const segments: Array<[string, number]> = d.byProject.map((s) => [
        sliceKey(s),
        secondsToHours(s.seconds),
      ]);
      const hours = segments.reduce((a, [, h]) => a + h, 0);
      return {
        day: weekdayLabel(d.date) || d.date,
        hours,
        segments,
      };
    });
    // Remote-task projects (#110) aren't in `projectsById`; synthesize a label
    // entry per remote group so the summary names them instead of their key.
    const remoteProjects = Object.fromEntries(
      summaryData.byProject
        .filter((s) => s.remoteProjectName)
        .map((s) => [
          s.remoteProjectName as string,
          {
            id: s.remoteProjectName as string,
            name: s.remoteProjectName as string,
            clientId: null,
            color: "#999",
            archived: false,
            estimateHours: null,
          },
        ]),
    );
    const summary = buildWeekSummary({
      weekLabel: formatRangeLabel(summaryData),
      week,
      projectsById: {
        ...projectsById,
        ...remoteProjects,
        _none: {
          id: "_none",
          name: "No project",
          clientId: null,
          color: "#999",
          archived: false,
          estimateHours: null,
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
          <span className="total-lbl">
            {(data?.byProject.length ?? 0) === 1 ? "project" : "projects"}
          </span>
        </div>
      </section>

      <section
        className="chart"
        aria-label={`Hours per ${digest?.averageUnit ?? "day"}`}
      >
        <div className="chart-grid">
          {axis.ticks.map((h) => (
            <div
              key={h}
              className="chart-line"
              style={{ bottom: `${(h / axisMaxHours) * 100}%` }}
              aria-hidden="true"
            >
              <span className="chart-axis">{h}</span>
            </div>
          ))}
          <div className="chart-bars">
            {buckets.map((b) => {
              const heightPct = (b.totalSeconds / axis.maxSeconds) * 100;
              const hours = secondsToHours(b.totalSeconds);
              return (
                <div
                  key={b.key}
                  className={`bar-col${b.isCurrent ? " is-today" : ""}${b.isFuture ? " is-future" : ""}`}
                  aria-label={`${b.label}: ${hours.toFixed(1)} hours${b.isCurrent ? " (current)" : ""}`}
                >
                  <div
                    className="bar-stack"
                    style={{ height: `${heightPct}%` }}
                  >
                    {b.segments.map((s) => (
                      <div
                        key={sliceKey(s)}
                        className="bar-seg"
                        style={{
                          flex: s.seconds,
                          background: projectColor(s.projectId),
                        }}
                        title={`${sliceName(s)}: ${secondsToHours(s.seconds).toFixed(1)}h`}
                      />
                    ))}
                  </div>
                  <div className="bar-meta">
                    <span className="bar-h">
                      {b.totalSeconds > 0 ? hours.toFixed(1) : "·"}
                    </span>
                    <span className="bar-d">{b.label}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {digest && (
        <section className="rep-digest" aria-label="Digest">
          <div className="rep-stat">
            <span className="rep-stat-num">
              <Mono>{secondsToHours(digest.averageSeconds).toFixed(1)}</Mono>h
              <span className="rep-stat-unit">
                {averageUnitLabel(digest.averageUnit)}
              </span>
            </span>
            <span className="rep-stat-lbl">average</span>
          </div>
          <div className="rep-stat">
            <span className="rep-stat-num">
              {digest.busiest ? (
                <>
                  <Mono>
                    {secondsToHours(digest.busiest.seconds).toFixed(1)}
                  </Mono>
                  h
                </>
              ) : (
                <Mono>—</Mono>
              )}
            </span>
            <span className="rep-stat-lbl">
              busiest{digest.busiest ? ` · ${digest.busiest.label}` : ""}
            </span>
          </div>
          <div className="rep-stat">
            <span className="rep-stat-num">
              {digest.topProject ? (
                <>
                  <Mono>{digest.topProject.percent.toFixed(0)}</Mono>%
                </>
              ) : (
                <Mono>—</Mono>
              )}
            </span>
            <span className="rep-stat-lbl">
              {digest.topProject
                ? `top · ${sliceName(digest.topProject.slice)}`
                : "top project"}
            </span>
          </div>
          <div className="rep-stat">
            <span className="rep-stat-num">
              <Mono>{digest.daysTracked}</Mono>
              <span className="rep-stat-unit">/{digest.daysElapsed}</span>
            </span>
            <span className="rep-stat-lbl">days tracked</span>
          </div>
        </section>
      )}

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
              <li key={sliceKey(slice)} className="bd-row">
                <span
                  className="proj-dot"
                  style={{ background: color, width: 8, height: 8 }}
                />
                <span className="bd-name">{sliceName(slice)}</span>
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
            style={{
              width: `${percentOf(data?.bySource.rule ?? 0, honestyTotal)}%`,
            }}
            data-testid="hon-rule"
          />
          <span
            className="hon-seg hon-cal"
            style={{
              width: `${percentOf(data?.bySource.calendar ?? 0, honestyTotal)}%`,
            }}
            data-testid="hon-cal"
          />
          <span
            className="hon-seg hon-manual"
            style={{
              width: `${percentOf(data?.bySource.manual ?? 0, honestyTotal)}%`,
            }}
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
              {percentOf(data?.bySource.calendar ?? 0, honestyTotal).toFixed(0)}
              %
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
