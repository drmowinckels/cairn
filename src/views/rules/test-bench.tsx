import { useEffect, useState } from "react";
import { Icon } from "../../lib/icon";
import { ProjectChip, Tag } from "../../lib/components";
import {
  dryRunRules,
  inTauri,
  type DryRunResult,
  type DryRunSnapshot,
} from "../../lib/ipc";

const MAX_BENCH_FIELD = 2 * 1024;

const DEFAULTS: { ideFolder: string; gitBranch: string; windowTitle: string } = {
  ideFolder: "~/code/cairn",
  gitBranch: "feat/rules-ui",
  windowTitle: "rules.tsx — cairn",
};

interface State {
  ideFolder: string;
  gitBranch: string;
  windowTitle: string;
}

/**
 * The "Test bench" in the heavy-complexity rule editor (issue #13,
 * DESIGN_SPEC §3.3, RULES_ENGINE.md §7). Three inputs — IDE folder,
 * git branch, window title — and a live result row showing which
 * rule (if any) the engine would pick for that synthetic snapshot.
 *
 * The backend `dry_run_rules` IPC reuses the same `evaluate` codepath
 * the live fanout uses, so what the user sees here is exactly what
 * they'd see if the snapshot fired for real. Outside Tauri (Vite
 * dev / vitest) `dryRunRules` returns `null` and we surface the
 * "no match" row, which is the honest answer for a no-backend build.
 *
 * Other signals (browser.domain, calendar.event) are deferred to a
 * follow-up — the spec calls this out as "extend in a follow-up."
 */
export function RuleTestBench() {
  const [state, setState] = useState<State>({
    ideFolder: DEFAULTS.ideFolder,
    gitBranch: DEFAULTS.gitBranch,
    windowTitle: DEFAULTS.windowTitle,
  });
  const [result, setResult] = useState<DryRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const snapshot: DryRunSnapshot = {
      ideFolder: emptyToNull(state.ideFolder),
      gitBranch: emptyToNull(state.gitBranch),
      windowTitle: emptyToNull(state.windowTitle),
    };
    dryRunRules(snapshot)
      .then((r) => {
        if (cancelled) return;
        setResult(r);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setResult(null);
      });
    return () => {
      cancelled = true;
    };
  }, [state.ideFolder, state.gitBranch, state.windowTitle]);

  const setField = (field: keyof State, value: string) =>
    setState((prev) => ({ ...prev, [field]: value }));

  return (
    <section className="test-bench" aria-label="Test bench">
      <div className="sect-label">
        <span>Test bench</span>
        <span className="sect-meta">Simulate signals against your rules</span>
      </div>
      <div className="bench-inputs">
        <BenchField
          label="IDE folder"
          value={state.ideFolder}
          onChange={(v) => setField("ideFolder", v)}
        />
        <BenchField
          label="Git branch"
          value={state.gitBranch}
          onChange={(v) => setField("gitBranch", v)}
        />
        <BenchField
          label="Window title"
          value={state.windowTitle}
          onChange={(v) => setField("windowTitle", v)}
        />
      </div>
      <BenchResult result={result} error={error} />
    </section>
  );
}

function BenchResult({
  result,
  error,
}: {
  result: DryRunResult | null;
  error: string | null;
}) {
  if (error) {
    return (
      <div className="bench-result bench-result--err" role="status">
        <span className="bench-arrow">
          <Icon name="info" size={12} />
        </span>
        <span>dry-run failed: {error}</span>
      </div>
    );
  }
  if (!result) {
    // The "no match" row covers both the fixture / outside-Tauri
    // path (where `dryRunRules` returns null up front) and the
    // backend-said-None path. Same shape, so the user gets a stable
    // landmark even when the bench is informational only.
    return (
      <div className="bench-result bench-result--none" role="status">
        <span className="bench-arrow">
          <Icon name="arrow-right" size={12} />
        </span>
        <span>
          {inTauri
            ? "no rule matches"
            : "preview unavailable outside the app"}
        </span>
      </div>
    );
  }
  return (
    <div className="bench-result" role="status">
      <span className="bench-arrow">
        <Icon name="arrow-right" size={12} />
      </span>
      <span>
        matches <strong>{result.ruleName}</strong>
        {result.project ? " → assigns " : null}
      </span>
      {result.project ? <ProjectChip id={result.project} /> : null}
      {result.tags.length > 0 ? (
        <span className="bench-tags">
          {result.tags.map((t) => (
            <Tag key={t}>{t}</Tag>
          ))}
        </span>
      ) : null}
    </div>
  );
}

interface BenchFieldProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
}

function BenchField({ label, value, onChange }: BenchFieldProps) {
  return (
    <label className="bench-field">
      <span className="bench-label">{label}</span>
      <input
        className="bench-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={MAX_BENCH_FIELD}
        aria-label={label}
      />
    </label>
  );
}

function emptyToNull(v: string): string | null {
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}
