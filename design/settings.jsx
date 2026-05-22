// settings.jsx — privacy front-and-center, then accessibility, then everything else.

const SettingsView = ({ density }) => {
  return (
    <div className="view view-settings" data-density={density}>

      {/* PRIVACY — first, large, reassuring */}
      <section className="privacy-card" aria-label="Privacy">
        <div className="privacy-head">
          <Icon name="shield" size={18} />
          <h2 className="privacy-title">Your data stays here</h2>
        </div>
        <ul className="privacy-list">
          <li><Icon name="check" size={13} /> Everything is stored locally in SQLite on this machine.</li>
          <li><Icon name="check" size={13} /> No accounts. No telemetry. No background phone-home.</li>
          <li><Icon name="check" size={13} /> Window titles are read locally and never leave the device.</li>
          <li><Icon name="check" size={13} /> Source on GitHub · Apache-2.0 licensed.</li>
        </ul>
        <div className="privacy-actions">
          <button className="btn btn--ghost btn--sm">Export all data…</button>
          <button className="btn btn--ghost btn--sm">View what's stored</button>
          <button className="btn btn--ghost btn--sm">Delete everything…</button>
        </div>
      </section>

      {/* EXCLUSIONS */}
      <section className="settings-block">
        <h3 className="settings-h">Never track these</h3>
        <p className="settings-sub">Cairn won't observe these apps, URLs, or windows — not even to count idle time.</p>
        <ul className="excl-list">
          <li className="excl-row">
            <Icon name="lock" size={12} />
            <code>1Password</code>
            <span className="excl-kind">app</span>
            <button className="excl-x" aria-label="Remove"><Icon name="x" size={11} /></button>
          </li>
          <li className="excl-row">
            <Icon name="lock" size={12} />
            <code>*.bank.com</code>
            <span className="excl-kind">domain</span>
            <button className="excl-x" aria-label="Remove"><Icon name="x" size={11} /></button>
          </li>
          <li className="excl-row">
            <Icon name="lock" size={12} />
            <code>Messages</code>
            <span className="excl-kind">app</span>
            <button className="excl-x" aria-label="Remove"><Icon name="x" size={11} /></button>
          </li>
          <li className="excl-row excl-add">
            <Icon name="plus" size={12} />
            <input placeholder="Add an app, domain, or window title pattern…" aria-label="Add exclusion" />
          </li>
        </ul>
        <label className="settings-check">
          <input type="checkbox" defaultChecked />
          <span>Pause tracking on private/incognito browser windows</span>
        </label>
      </section>

      {/* ACCESSIBILITY */}
      <section className="settings-block">
        <h3 className="settings-h">Accessibility</h3>
        <p className="settings-sub">Cairn should be usable by everyone.</p>

        <SetRow label="Text size" hint="Scales the whole UI.">
          <div className="seg seg--sm">
            <button className="seg-btn">A−</button>
            <button className="seg-btn is-on">Aa</button>
            <button className="seg-btn">A+</button>
            <button className="seg-btn">A++</button>
          </div>
        </SetRow>

        <SetRow label="High contrast" hint="Stronger borders and text contrast.">
          <Toggle on={false} />
        </SetRow>

        <SetRow label="Reduce motion" hint="Disable timeline animations and idle pulse.">
          <Toggle on={true} />
        </SetRow>

        <SetRow label="Colorblind-safe palette" hint="Swap project colors for an Okabe–Ito palette.">
          <Toggle on={false} />
        </SetRow>

        <SetRow label="Screen reader announcements" hint="Announce timer start/stop and detection prompts.">
          <Toggle on={true} />
        </SetRow>

        <SetRow label="Focus rings always visible" hint="Show focus indicators even when navigating with a mouse.">
          <Toggle on={false} />
        </SetRow>

        <SetRow label="Detection prompts" hint="How insistent should auto-detection be?">
          <div className="seg seg--sm">
            <button className="seg-btn">Off</button>
            <button className="seg-btn is-on">Subtle</button>
            <button className="seg-btn">Modal</button>
          </div>
        </SetRow>
      </section>

      {/* SHORTCUTS */}
      <section className="settings-block">
        <h3 className="settings-h">Shortcuts</h3>
        <ul className="short-list">
          <li><span>Open / hide Cairn</span><span className="kbds"><Kbd>⌃</Kbd><Kbd>⌥</Kbd><Kbd>T</Kbd></span></li>
          <li><span>Start / stop timer</span><span className="kbds"><Kbd>⌃</Kbd><Kbd>⌥</Kbd><Kbd>␣</Kbd></span></li>
          <li><span>Confirm suggestion</span><span className="kbds"><Kbd>↵</Kbd></span></li>
          <li><span>Change project</span><span className="kbds"><Kbd>⌘</Kbd><Kbd>K</Kbd></span></li>
          <li><span>Switch view</span><span className="kbds"><Kbd>1</Kbd>–<Kbd>4</Kbd></span></li>
        </ul>
      </section>

      {/* INTEGRATIONS — calendar */}
      <section className="settings-block">
        <h3 className="settings-h">Integrations</h3>
        <ul className="intg-list">
          <li className="intg-row">
            <Icon name="calendar" size={14} />
            <span className="intg-name">Calendar</span>
            <span className="intg-status">3 accounts · read-only</span>
            <button className="link-btn">Configure…</button>
          </li>
          <li className="intg-row">
            <Icon name="branch" size={14} />
            <span className="intg-name">Git</span>
            <span className="intg-status">4 watched repos</span>
            <button className="link-btn">Manage…</button>
          </li>
          <li className="intg-row">
            <Icon name="globe" size={14} />
            <span className="intg-name">Browsers</span>
            <span className="intg-status">Safari, Firefox · via extension</span>
            <button className="link-btn">Install…</button>
          </li>
        </ul>
      </section>

      <p className="settings-foot">
        Cairn v0.7.0 · Apache-2.0 · <a href="#" onClick={e=>e.preventDefault()}>github.com/cairn-app/cairn</a>
      </p>
    </div>
  );
};

const SetRow = ({ label, hint, children }) => (
  <div className="set-row">
    <div className="set-row-meta">
      <div className="set-row-label">{label}</div>
      {hint && <div className="set-row-hint">{hint}</div>}
    </div>
    <div className="set-row-ctrl">{children}</div>
  </div>
);

const Toggle = ({ on }) => {
  const [v, setV] = useState(on);
  return (
    <button
      className={`tgl${v ? " is-on" : ""}`}
      role="switch"
      aria-checked={v}
      onClick={() => setV(!v)}
    >
      <span className="tgl-dot" />
    </button>
  );
};

Object.assign(window, { SettingsView, SetRow, Toggle });
