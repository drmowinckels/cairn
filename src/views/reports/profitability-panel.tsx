import { Empty, ErrorBanner, Mono } from "../../lib/components";
import { formatMoney } from "../../lib/money";
import { secondsToHours } from "../../lib/report-math";
import type { ProjectProfit, ReportRange } from "../../lib/ipc";
import type { Rounding } from "../../lib/rounding";
import type { Project } from "../../lib/types";
import { useProfitability } from "../../lib/use-profitability";

interface Props {
  range: ReportRange;
  rounding: Rounding;
  projectsById: Record<string, Project>;
}

function hours(seconds: number): string {
  return secondsToHours(seconds).toFixed(1);
}

function projectName(
  p: ProjectProfit,
  projectsById: Record<string, Project>,
): string {
  if (p.projectId) return projectsById[p.projectId]?.name ?? p.projectId;
  if (p.remoteProjectName) return p.remoteProjectName;
  return "No project";
}

/** The Reports → Profitability tab (#109). Billable vs non-billable hours
 *  and billable amounts by project, priced by the rate model. Only mounts
 *  when Pro is active (the tab is hidden otherwise). */
export function ProfitabilityPanel({ range, rounding, projectsById }: Props) {
  const { data, loading, error, refresh } = useProfitability(range, {
    rounding,
  });

  if (error) return <ErrorBanner message={error} onRetry={refresh} />;
  if (!data) {
    return loading ? (
      <p className="settings-sub" data-profit="loading">
        Loading…
      </p>
    ) : null;
  }
  if (data.byProject.length === 0) {
    return (
      <Empty
        title="No time tracked"
        body="Mark projects or entries billable and set a rate to see billable amounts here."
      />
    );
  }

  return (
    <section className="rep-profit" aria-label="Profitability">
      <div className="totals" aria-label="Billable totals">
        {data.totals.map((t) => (
          <div className="total" key={t.currency}>
            <span className="total-num">
              <Mono>{formatMoney(t.amountCents, t.currency)}</Mono>
            </span>
            <span className="total-lbl">{t.currency} billable</span>
          </div>
        ))}
        <div className="total">
          <span className="total-num">
            <Mono>{hours(data.billableSeconds)}</Mono>h
          </span>
          <span className="total-lbl">billable</span>
        </div>
        <div className="total">
          <span className="total-num">
            <Mono>{hours(data.nonbillableSeconds)}</Mono>h
          </span>
          <span className="total-lbl">non-billable</span>
        </div>
      </div>

      {data.unratedBillableSeconds > 0 && (
        <p className="settings-sub" data-profit="unrated">
          <Mono>{hours(data.unratedBillableSeconds)}</Mono>h billable but
          unpriced — set a rate to bill it.
        </p>
      )}

      <div className="rep-profit-scroll">
        <table className="rep-profit-table">
          <thead>
            <tr>
              <th scope="col">Project</th>
              <th scope="col">Billable</th>
              <th scope="col">Non-billable</th>
              <th scope="col">Amount</th>
            </tr>
          </thead>
          <tbody>
            {data.byProject.map((p) => (
              <tr key={p.projectId ?? p.remoteProjectName ?? "_none"}>
                <td>{projectName(p, projectsById)}</td>
                <td>
                  <Mono>{hours(p.billableSeconds)}</Mono>h
                </td>
                <td>
                  <Mono>{hours(p.nonbillableSeconds)}</Mono>h
                </td>
                <td>
                  {p.amounts.length
                    ? p.amounts
                        .map((a) => formatMoney(a.amountCents, a.currency))
                        .join(" · ")
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
