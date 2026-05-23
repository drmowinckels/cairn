# Contributing to Cairn

Thanks for considering a contribution! Cairn is open-source under [Apache 2.0](LICENSE).

## Ground rules

1. **Local-first is non-negotiable.** Read [`docs/PRIVACY.md`](docs/PRIVACY.md) before proposing any feature that touches signals, storage, or networking. New outbound network calls require an explicit `[privacy]` discussion in the PR description.
2. **Accessibility first.** Every interactive element must be keyboard reachable with a visible focus ring. Honor `prefers-reduced-motion`. New UI shouldn't regress the WCAG checks in `docs/DESIGN_SPEC.md` §7.
3. **Match the design.** The visual source of truth is `design/Cairn.html`. Pixel changes need a corresponding update to the prototype (or a PR comment explaining why the prototype is now wrong).

## Workflow

```bash
# Toolchain
rustup default stable
cargo install tauri-cli
npm install

# Run in dev
npm run tauri dev

# Format & lint
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm run typecheck

# Tests
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm test
npm run coverage     # vitest with v8 coverage
```

## Audits

These all run in CI; run them locally to fail fast:

```bash
npm run audit:knip       # unused exports / deps
npm run audit:spell      # cspell (add new project terms to .github/audit/cspell/project-words.txt)
npm run audit:size       # bundle-size budget (JS + CSS, gzip)
npm run audit:a11y       # builds the app, drives Chromium, runs axe on every tab × light/dark
npm run audit:links      # lychee broken-link check across docs (needs lychee installed)
npm run audit:rust       # cargo deny (licenses + advisories)
```

## Cross-platform from day one

Every PR is built and tested on **macOS, Ubuntu, and Windows**. Rust code that
cannot work on a given OS should `#[cfg]`-gate gracefully (return `None`, log a
warning) — never produce a compile error on the matrix. Mock-runtime tests
(`tauri::test::mock_app`) are gated off Windows; see the `[target.cfg(not(target_os = "windows"))'.dev-dependencies]`
note in `src-tauri/Cargo.toml`.

## Writing tests

- Frontend: colocate `*.test.ts(x)` next to the unit under test. Mock
  `@tauri-apps/api/core` via `vi.mock`. Use the `inTauri` flag to assert the
  no-Tauri branch separately.
- Rust: keep pure logic free of `Db` / `AppHandle` and unit-test it in a
  `#[cfg(test)] mod tests` next to the code. For DB / event paths, use the
  `test_support` helpers (`test_db()`, `mock_app_with_db()`) — they thread the
  same migrations + seed as the runtime through a `TempDir`.

## PR checklist

- [ ] `cargo fmt --check && cargo clippy --all-targets -- -D warnings` clean
- [ ] `npm run typecheck` clean
- [ ] `npm test` and `cargo test` green
- [ ] Tests added / updated for new code paths
- [ ] If UI changed: prototype in `design/` also updated, or PR explains the divergence
- [ ] If signal/storage/network behavior changed: PRIVACY.md reviewed and CHANGELOG `[privacy]` entry added
- [ ] If a new accessibility-relevant feature: setting toggle added or explained why none is needed

## DCO

By contributing, you affirm the [Developer Certificate of Origin](https://developercertificate.org/). Sign your commits: `git commit -s`.
