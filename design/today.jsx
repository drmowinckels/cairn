// today.jsx — the main "Now / Today" view inside the popover.

const TodayView = ({ density, layoutVariant, onOpenRule, suggestionDismissed, setSuggestionDismissed, showIdleModal, setShowIdleModal }) => {
  const compact = density === "compact";

  // Live-ticking second on the running timer
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  // Running duration in seconds — base is (NOW_MIN - RUNNING.start) minutes, plus 14 seconds anchor, plus tick
  const runMin = NOW_MIN - RUNNING.start;
  const runSec = runMin * 60 + 14 + tick;
  const hh = String(Math.floor(runSec / 3600)).padStart(2, "0");
  const mm = String(Math.floor((runSec % 3600) / 60)).padStart(2, "0");
  const ss = String(runSec % 60).padStart(2, "0");

  return (
    <div className="view view-today" data-density={density}>
      {/* Auto-detect suggestion banner */}
      {!suggestionDismissed && (
        <section className="suggest" aria-label="Auto-detected work">
          <div className="suggest-head">
            <Icon name="sparkle" size={13} />
            <span>Detected</span>
            <button
              className="suggest-x"
              onClick={() => setSuggestionDismissed(true)}
              aria-label="Dismiss suggestion"
            ><Icon name="x" size={12} /></button>
          </div>
          <div className="suggest-body">
            Working on <ProjectChip id="cairn" /> — <em>Rule preview UI</em>?
          </div>
          <div className="suggest-why">
            because <code>feat/rules-ui</code> · folder <code>~/code/cairn</code>
            <button className="suggest-link" onClick={() => onOpenRule("r1")}>view rule</button>
          </div>
          <div className="suggest-actions">
            <button className="btn btn--primary">
              <Icon name="check" size={13} /> Confirm
            </button>
            <button className="btn btn--ghost">Change…</button>
          </div>
        </section>
      )}

      {/* Idle modal */}
      {showIdleModal && (
        <section className="idle" role="alertdialog" aria-labelledby="idle-h">
          <div className="idle-head">
            <Icon name="moon" size={14} /> <span id="idle-h">You were away</span>
          </div>
          <div className="idle-body">
            No input detected from <strong>14:50</strong> to <strong>15:02</strong>
            <span className="idle-dur">12 min</span>
          </div>
          <div className="idle-actions">
            <button className="btn btn--primary" onClick={() => setShowIdleModal(false)}>Keep</button>
            <button className="btn btn--ghost" onClick={() => setShowIdleModal(false)}>Discard idle</button>
            <button className="btn btn--ghost" onClick={() => setShowIdleModal(false)}>Move to break</button>
          </div>
        </section>
      )}

      {/* Running timer */}
      <section className="now" aria-label="Current timer">
        <div className="now-meta">
          <span className="now-label">Now · running</span>
          <span className="now-source" title="Started automatically by a rule">
            <Icon name="sparkle" size={11} /> rule
          </span>
        </div>
        <div className="now-time" aria-live="polite">
          <span className="t-hms">{hh}<span className="t-sep">:</span>{mm}<span className="t-sep">:</span>{ss}</span>
        </div>
        <div className="now-task">
          <input
            className="now-input"
            defaultValue={RUNNING.task}
            aria-label="Task description"
            placeholder="What are you working on?"
          />
        </div>
        <div className="now-row">
          <div className="now-chips">
            <ProjectChip id={RUNNING.project} interactive />
            {RUNNING.tags.map(t => <Tag key={t}>{t}</Tag>)}
          </div>
          <button className="btn btn--stop" aria-label="Stop timer">
            <Icon name="stop" size={12} /> Stop
          </button>
        </div>
      </section>

      {/* Layout variant: projects-first shows quick-pick chips here */}
      {layoutVariant === "projects-first" && (
        <section className="quick" aria-label="Quick-start a project">
          <div className="sect-label">Quick start</div>
          <div className="quick-grid">
            {PROJECTS.slice(0, 4).map(p => (
              <button key={p.id} className="quick-card">
                <span className="proj-dot" style={{ background: p.color, width: 8, height: 8 }} />
                <span className="quick-name">{p.name}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Today's timeline */}
      <section className="timeline" aria-label="Today's timeline">
        <div className="sect-label">
          <span>Today's path</span>
          <span className="sect-meta">{fmtHm(4*60+12)} logged · {fmtHm(18*60+34)} this week</span>
        </div>
        <DayTimeline />
        <div className="legend">
          {[...new Set(TODAY.map(t => t.project).concat([RUNNING.project]))].map(pid => (
            <span key={pid} className="legend-item">
              <span className="proj-dot" style={{ background: PROJECT_BY_ID[pid].color }} />
              {PROJECT_BY_ID[pid].name}
            </span>
          ))}
        </div>
      </section>

      {/* Recent entries — hidden in compact density */}
      {!compact && layoutVariant !== "projects-first" && (
        <section className="recent" aria-label="Recent entries">
          <div className="sect-label">
            <span>Recent</span>
            <button className="link-btn">Edit…</button>
          </div>
          <ul className="entries">
            {[...TODAY].reverse().slice(0, 4).map((e, i) => (
              <li key={i} className="entry">
                <span className="entry-time">{fmtClock(e.start)}</span>
                <span className="proj-dot" style={{ background: PROJECT_BY_ID[e.project].color }} />
                <span className="entry-task">{e.task}</span>
                <span className="entry-dur">{fmtHm(e.end - e.start)}</span>
                {e.source.startsWith("rule") && <Icon name="sparkle" size={10} className="entry-src" />}
                {e.source === "calendar" && <Icon name="calendar" size={10} className="entry-src" />}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Upcoming */}
      <section className="upcoming">
        <div className="sect-label"><span>Up next</span></div>
        <ul className="up-list">
          {UPCOMING.map((u, i) => (
            <li key={i} className="up-item">
              <span className="up-time">{fmtClock(u.at)}</span>
              <span className="up-label">{u.label}</span>
              <span className="up-dur">{u.duration}m</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
};

// ─── Day timeline strip ─────────────────────────────────────────────────
const DAY_START = 8 * 60;
const DAY_END   = 19 * 60;
const DAY_SPAN  = DAY_END - DAY_START;

const DayTimeline = () => {
  const pct = (m) => ((m - DAY_START) / DAY_SPAN) * 100;
  const nowPct = pct(NOW_MIN);

  // Combine TODAY + RUNNING for display
  const entries = [
    ...TODAY,
    { start: RUNNING.start, end: NOW_MIN, project: RUNNING.project, task: RUNNING.task, running: true },
  ];

  return (
    <div className="dt-wrap" role="img" aria-label="Today's timeline from 08:00 to 19:00">
      <div className="dt-track">
        {entries.map((e, i) => (
          <div
            key={i}
            className={`dt-seg${e.running ? " is-running" : ""}`}
            style={{
              left: `${pct(e.start)}%`,
              width: `${pct(e.end) - pct(e.start)}%`,
              background: PROJECT_BY_ID[e.project].color,
            }}
            title={`${e.task} · ${fmtRange(e.start, e.end)}`}
          />
        ))}
        <div className="dt-now" style={{ left: `${nowPct}%` }} aria-label="Now">
          <span className="dt-now-label">{fmtClock(NOW_MIN)}</span>
        </div>
      </div>
      <div className="dt-axis">
        {[8, 10, 12, 14, 16, 18].map(h => (
          <span key={h} className="dt-tick" style={{ left: `${pct(h*60)}%` }}>{h}</span>
        ))}
      </div>
    </div>
  );
};

Object.assign(window, { TodayView, DayTimeline });
