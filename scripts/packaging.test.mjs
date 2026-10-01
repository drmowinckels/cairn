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

/**
 * The macOS App Group id is declared independently in five files across three
 * languages, and every comment that mentions it says "keep these in lockstep"
 * — which nothing enforced. Drift doesn't fail a build: the app binds one
 * socket path, the extension connects to another, and Settings → Integrations
 * just reads disconnected with no error to explain it (#250).
 */
describe("macOS App Group (#250)", () => {
  // Each entry is the one line in that file that declares the id, so the
  // regex fails loudly if a file is restructured rather than silently
  // matching some other mention of the group in prose.
  const idIn = (file, pattern) =>
    readFileSync(file, "utf8").match(pattern)?.[1];

  // The entitlement is the source of truth: it is what actually asks macOS
  // for the group. Every other declaration is a copy that has to agree.
  const entitled = idIn(
    "src-tauri/entitlements.plist",
    /application-groups<\/key>\s*<array>\s*<string>([\w.]+)<\/string>/,
  );

  const copies = [
    ["src-tauri/src/plugins/browser/mod.rs", /APP_GROUP_ID: &str = "([\w.]+)"/],
    [
      "browser-extension/native-host/src/main.rs",
      /MACOS_APP_GROUP_ID: &str = "([\w.]+)"/,
    ],
    [
      "browser-extension/safari/handler/Handler.swift",
      /cairnAppGroupID = "([\w.]+)"/,
    ],
    ["browser-extension/safari/build-wrapper.sh", /^group="([\w.]+)"$/m],
  ].map(([file, pattern]) => [file, idIn(file, pattern)]);

  it("is declared as an entitlement, not just referenced in comments", () => {
    // Without the key the four copies below agree with each other and none
    // of them works: the app never gets the container.
    expect(entitled).toBeDefined();
  });

  it("carries the Team ID prefix macOS requires", () => {
    // macOS grants the entitlement only for a group owned by the signing
    // team, so an unprefixed id is not a real App Group — just a directory,
    // which is why the sandboxed Safari handler could never use the old one.
    expect(entitled).toMatch(/^[A-Z0-9]{10}\.group\./);
  });

  it.each(copies)("%s matches the entitlement", (_file, id) => {
    expect(id).toBe(entitled);
  });

  it("is authorized by an embedded provisioning profile, and checked", () => {
    // Declaring the entitlement is not enough: on a Developer ID build macOS
    // honours a restricted entitlement only when the bundle embeds a profile
    // authorizing it. Dropping either the embed or the post-build check would
    // leave a release that signs, notarizes, reports nothing wrong, and has
    // no group container.
    expect(release).toContain("embedded.provisionprofile");
    expect(release).toContain("APPLE_PROVISIONING_PROFILE");
    expect(release).toMatch(/Verify the provisioning profile is embedded/);
  });
});
