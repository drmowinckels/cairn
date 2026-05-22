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
pnpm install

# Run in dev
pnpm tauri dev

# Format & lint
cargo fmt && cargo clippy -- -D warnings
pnpm lint && pnpm typecheck

# Tests
cargo test
pnpm test
```

## PR checklist

- [ ] `cargo fmt && cargo clippy -- -D warnings` clean
- [ ] `pnpm typecheck && pnpm lint` clean
- [ ] Tests added / updated
- [ ] If UI changed: prototype in `design/` also updated, or PR explains the divergence
- [ ] If signal/storage/network behavior changed: PRIVACY.md reviewed and CHANGELOG `[privacy]` entry added
- [ ] If a new accessibility-relevant feature: setting toggle added or explained why none is needed

## DCO

By contributing, you affirm the [Developer Certificate of Origin](https://developercertificate.org/). Sign your commits: `git commit -s`.
