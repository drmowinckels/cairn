// reports.jsx — weekly chart + project breakdown

const ReportsView = ({ density }) => {
  const weekTotal = WEEK.reduce((a, d) => a + d.hours, 0);
  const maxDay = Math.max(...WEEK.map(d => d.hours), 8);

  // Project totals across the week
  const projTotals = {};
  WEEK.forEach(d => d.segments.forEach(([pid, h]) => {
    projTotals[pid] = (projTotals[pid] || 0) + h;
  }));
  const sortedProjects = Object.entries(projTotals).sort((a, b) => b[1] - a[1]);

  return (
    <div className="view view-reports" data-density={density}>
      <header className="view-head">
        <div>
          <h2 className="view-title">This week</h2>
          <p className="view-sub">May 18 — May 24, 2026</p>
        </div>
        <div className="seg" role="tablist" aria-label="Period">
          <button className="seg-btn">Day</button>
          <button className="seg-btn is-active" aria-selected="true">Week</button>
          <button className="seg-btn">Month</button>
        </div>
      </header>

      <section className="totals">
        <div className="total">
          <span className="total-num"><Mono>{weekTotal.toFixed(1)}</Mono>h</span>
          <span className="total-lbl">tracked</span>
        </div>
        <div className="total">
          <span className="total-num"><Mono>{(weekTotal / 4).toFixed(1)}</Mono>h</span>
          <span className="total-lbl">daily avg</span>
        </div>
        <div className="total">
          <span className="total-num"><Mono>{sortedProjects.length}</Mono></span>
          <span className="total-lbl">projects</span>
        </div>
      </section>

      <section className="chart" aria-label="Hours per day">
        <div className="chart-bars">
          {WEEK.map((d, i) => {
            const total = d.hours;
            return (
              <div key={i} className={`bar-col${d.today ? " is-today" : ""}${d.future ? " is-future" : ""}`}>
                <div className="bar-stack" style={{ height: `${(total / maxDay) * 100}%` }}>
                  {d.segments.map(([pid, h], j) => (
                    <div
                      key={j}
                      className="bar-seg"
                      style={{
                        flex: h,
                        background: PROJECT_BY_ID[pid].color,
                      }}
                      title={`${PROJECT_BY_ID[pid].name}: ${h.toFixed(1)}h`}
                    />
                  ))}
                </div>
                <div className="bar-meta">
                  <span className="bar-h">{total ? total.toFixed(1) : "·"}</span>
                  <span className="bar-d">{d.day}</span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="breakdown" aria-label="Project breakdown">
        <div className="sect-label"><span>By project</span></div>
        <ul className="bd-list">
          {sortedProjects.map(([pid, h]) => {
            const p = PROJECT_BY_ID[pid];
            const pct = (h / weekTotal) * 100;
            return (
              <li key={pid} className="bd-row">
                <span className="proj-dot" style={{ background: p.color, width: 8, height: 8 }} />
                <span className="bd-name">{p.name}</span>
                <div className="bd-bar">
                  <div className="bd-bar-fill" style={{ width: `${pct}%`, background: p.color }} />
                </div>
                <span className="bd-pct"><Mono>{pct.toFixed(0)}</Mono>%</span>
                <span className="bd-h"><Mono>{h.toFixed(1)}</Mono>h</span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="export-row">
        <button className="link-btn">Export CSV</button>
        <span className="dot-sep">·</span>
        <button className="link-btn">Export JSON</button>
        <span className="dot-sep">·</span>
        <button className="link-btn">Copy summary</button>
      </section>
    </div>
  );
};

const Mono = ({ children }) => <span className="mono">{children}</span>;

Object.assign(window, { ReportsView });
