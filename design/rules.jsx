// rules.jsx — rules list + builder (light / medium / heavy complexity)

const RulesView = ({ complexity, openRuleId, onOpenRule, density }) => {
  const [expanded, setExpanded] = useState(openRuleId || null);
  useEffect(() => { if (openRuleId) setExpanded(openRuleId); }, [openRuleId]);

  return (
    <div className="view view-rules" data-density={density}>
      <header className="view-head">
        <div>
          <h2 className="view-title">Rules</h2>
          <p className="view-sub">
            Tried in order from top. First match wins.
            {complexity !== "light" && " Each rule may combine multiple signals."}
          </p>
        </div>
        <button className="btn btn--ghost btn--sm" aria-label="New rule">
          <Icon name="plus" size={13} /> New
        </button>
      </header>

      {/* Live signals — only in medium/heavy */}
      {complexity !== "light" && (
        <section className="signals" aria-label="Live signals">
          <div className="sect-label"><span>Live signals</span><span className="sect-meta">use these in conditions</span></div>
          <ul className="sig-list">
            {LIVE_SIGNALS.map((s, i) => (
              <li key={i} className="sig-item">
                <SignalIcon kind={s.signal} />
                <span className="sig-label">{SIGNAL_LABELS[s.signal]}</span>
                <code className="sig-value">{s.value}</code>
                <span className="sig-src">{s.app}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ul className="rule-list" role="list">
        {RULES.map((r, idx) => (
          <RuleRow
            key={r.id}
            rule={r}
            index={idx}
            expanded={expanded === r.id}
            onToggle={() => setExpanded(expanded === r.id ? null : r.id)}
            complexity={complexity}
          />
        ))}
      </ul>

      {complexity === "heavy" && (
        <section className="test-bench" aria-label="Test bench">
          <div className="sect-label">
            <span>Test bench</span>
            <span className="sect-meta">Simulate signals against your rules</span>
          </div>
          <div className="bench-inputs">
            <BenchField label="IDE folder" value="~/code/cairn" />
            <BenchField label="Git branch" value="feat/rules-ui" />
            <BenchField label="Window title" value="rules.jsx — cairn" />
          </div>
          <div className="bench-result">
            <span className="bench-arrow"><Icon name="arrow-right" size={12} /></span>
            <span>matches <strong>Cairn dev work</strong> → assigns </span>
            <ProjectChip id="cairn" />
            <span className="bench-tags"><Tag>dev</Tag><Tag>feature</Tag></span>
          </div>
        </section>
      )}
    </div>
  );
};

// ─── Single rule row ────────────────────────────────────────────────────
const RuleRow = ({ rule, index, expanded, onToggle, complexity }) => {
  const project = rule.then.project ? PROJECT_BY_ID[rule.then.project] : null;

  return (
    <li className={`rule${expanded ? " is-open" : ""}${rule.enabled ? "" : " is-off"}`}>
      <header className="rule-head" onClick={onToggle} tabIndex={0} role="button" aria-expanded={expanded}>
        <Icon name="drag" size={14} className="rule-drag" />
        <span className="rule-num">{index + 1}</span>
        <span className="rule-name">{rule.name}</span>
        <span className="rule-summary">
          {rule.when.length === 1 ? (
            <RuleConditionPill cond={rule.when[0]} />
          ) : (
            <span className="rule-multi">{rule.when.length} conditions</span>
          )}
          <Icon name="arrow-right" size={11} className="rule-arrow" />
          {project ? <ProjectChip id={project.id} /> : <span className="rule-tags-only">+ tags</span>}
        </span>
        <span className="rule-stats">{rule.matchedToday}× today</span>
        <span className="rule-toggle">
          <input type="checkbox" defaultChecked={rule.enabled} aria-label={`Enable ${rule.name}`} onClick={e=>e.stopPropagation()} />
        </span>
        <Icon name={expanded ? "chevron-down" : "chevron-right"} size={14} className="rule-chev" />
      </header>

      {expanded && (
        <div className="rule-body">
          <div className="rule-when">
            <div className="sect-label">When</div>
            {rule.when.map((c, i) => (
              <div key={i} className="cond">
                {i > 0 && <span className="cond-join">{c.any ? "OR" : "AND"}</span>}
                <SignalIcon kind={c.signal} />
                <span className="cond-sig">{SIGNAL_LABELS[c.signal]}</span>
                <select className="cond-op" defaultValue={c.op} onClick={e=>e.stopPropagation()}>
                  {Object.entries(OP_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                <input className="cond-val" defaultValue={c.value} onClick={e=>e.stopPropagation()} />
                {complexity !== "light" && (
                  <button className="cond-x" aria-label="Remove condition" onClick={e=>e.stopPropagation()}>
                    <Icon name="x" size={11} />
                  </button>
                )}
              </div>
            ))}
            {complexity !== "light" && (
              <button className="add-cond" onClick={e=>e.stopPropagation()}>
                <Icon name="plus" size={11} /> add condition
              </button>
            )}
          </div>

          <div className="rule-then">
            <div className="sect-label">Then</div>
            <div className="then-row">
              <span className="then-key">Project</span>
              <select className="then-val" defaultValue={rule.then.project || ""} onClick={e=>e.stopPropagation()}>
                <option value="">— don't change —</option>
                {PROJECTS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="then-row">
              <span className="then-key">Tags</span>
              <div className="then-tags">
                {(rule.then.tags || []).map(t => <Tag key={t}>{t}</Tag>)}
                <button className="add-tag" onClick={e=>e.stopPropagation()}>+ tag</button>
              </div>
            </div>
            {rule.then.tagsFromCalendar && (
              <div className="then-row">
                <span className="then-key">Tags</span>
                <span className="then-note">from calendar attendees</span>
              </div>
            )}
          </div>

          {complexity === "heavy" && (
            <div className="rule-meta">
              <div className="rule-meta-row">
                <span>Confidence threshold</span>
                <span className="rule-conf">strict</span>
              </div>
              <div className="rule-meta-row">
                <span>If ambiguous</span>
                <span className="rule-amb">prompt me</span>
              </div>
            </div>
          )}

          <div className="rule-foot">
            <button className="link-btn">Duplicate</button>
            <button className="link-btn link-btn--danger">Delete</button>
          </div>
        </div>
      )}
    </li>
  );
};

// Compact pill summarizing a rule's first condition
const RuleConditionPill = ({ cond }) => (
  <span className="cond-pill">
    <SignalIcon kind={cond.signal} small />
    <span className="cond-pill-sig">{SIGNAL_LABELS[cond.signal]}</span>
    <span className="cond-pill-op">{OP_LABELS[cond.op]}</span>
    <code>{cond.value}</code>
  </span>
);

const SignalIcon = ({ kind, small }) => {
  const name =
    kind === "ide.folder"     ? "folder" :
    kind === "git.branch"     ? "branch" :
    kind === "browser.domain" ? "globe"  :
    kind === "browser.tab"    ? "globe"  :
    kind === "window.title"   ? "type"   :
    kind === "calendar.event" ? "calendar" :
    "info";
  return <Icon name={name} size={small ? 11 : 12} className="sig-ic" />;
};

const BenchField = ({ label, value }) => (
  <label className="bench-field">
    <span className="bench-label">{label}</span>
    <input className="bench-input" defaultValue={value} />
  </label>
);

Object.assign(window, { RulesView });
