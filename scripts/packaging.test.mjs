import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const release = readFileSync(".github/workflows/release.yml", "utf8");

/**
 * The Windows install path is a packaging invariant, not a preference (#299):
 * a managed work machine can't write `C:\Program Files`, so Cairn has to ship
 * an installer that doesn't ask to. Both halves of that guarantee live in
 * config files no unit test would otherwise touch — the install mode in
 * `tauri.conf.json` and the bundle list in the release workflow — and breaking
 * either one is invisible until a user on a locked-down machine can't install.
 */
describe("Windows packaging (#299)", () => {
  it("installs per-user, so no Administrator rights are needed", () => {
    // `currentUser` puts the app in %LOCALAPPDATA%. `both` is NOT an
    // alternative here: Tauri requires elevation for it even when the user
    // picks a current-user install, which is exactly the blocker #299 reports.
    expect(conf.bundle.windows.nsis.installMode).toBe("currentUser");
  });

  it("builds the NSIS setup alongside the MSI", () => {
    // WiX/MSI is per-machine by design, so the MSI alone can't satisfy the
    // above — the per-user path exists only if the NSIS bundle is built.
    const windowsArgs = release.match(
      /platform: windows-latest[\s\S]*?args: "(.*?)"/,
    );
    expect(windowsArgs).not.toBeNull();
    const bundles = windowsArgs[1].replace("--bundles ", "").split(",");
    expect(bundles).toContain("nsis");
    expect(bundles).toContain("msi");
  });
});
