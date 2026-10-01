import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The Rust toolchain is pinned in `rust-toolchain.toml` so a new stable release
 * can't fail an unchanged tree (#324: stable 1.99.0 turned
 * `clippy::double_must_use` into six errors across three `#[async_trait]`
 * traits, reddening main and every open PR at once).
 *
 * A pin is only worth having if nothing routes around it. These tests hold the
 * two halves of that: the file names an exact version, and no workflow installs
 * a toolchain of its own choosing. Both failures are invisible otherwise — CI
 * goes green on the wrong compiler and the pin becomes decoration.
 */
const toolchain = readFileSync("rust-toolchain.toml", "utf8");
const WORKFLOWS = [
  ".github/workflows/ci.yml",
  ".github/workflows/audit.yml",
  ".github/workflows/release.yml",
];

describe("Rust toolchain pin (#324)", () => {
  const channel = toolchain.match(/^channel = "(.*)"$/m)?.[1];

  it("pins an exact patch version, not a floating channel", () => {
    // `stable` would reintroduce the exact problem the pin exists to solve, and
    // `1.99` floats across patch releases — which is where a new lint lands.
    expect(channel).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("installs the components the local checks need", () => {
    // Without these, a contributor's first `cargo clippy` fails on a missing
    // component rather than on their code.
    expect(toolchain).toContain("clippy");
    expect(toolchain).toContain("rustfmt");
  });

  it.each(WORKFLOWS)("%s does not install its own stable", (file) => {
    // `dtolnay/rust-toolchain@stable` sets the toolchain itself. The pin file
    // still wins for cargo, but the action's `components:`/`targets:` then
    // apply to the WRONG toolchain — so a universal macOS build loses its
    // targets and coverage loses llvm-tools, both as confusing failures.
    expect(readFileSync(file, "utf8")).not.toContain(
      "dtolnay/rust-toolchain@stable",
    );
  });

  it.each(WORKFLOWS)(
    "%s takes the version from rust-toolchain.toml",
    (file) => {
      // The version must live in exactly one place; a workflow naming it again is
      // free to drift from the file silently.
      const content = readFileSync(file, "utf8");
      expect(content).toContain("rust-toolchain.toml");
      expect(content).toContain("steps.toolchain.outputs.channel");
      expect(content).not.toContain(`toolchain: ${channel}`);
    },
  );

  it("is exercised against new stable by a scheduled canary", () => {
    // The pin without the canary is just a freeze: it stops breakage and stops
    // upgrades. The canary is what keeps a bump a deliberate, pre-verified act.
    const canary = readFileSync(".github/workflows/rust-next.yml", "utf8");
    expect(canary).toContain("schedule:");
    // It has to ignore the pin, or it just re-tests the pinned version.
    expect(canary).toContain("RUSTUP_TOOLCHAIN: stable");
  });
});
