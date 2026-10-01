import { writeFileSync } from "node:fs";
import { argv } from "node:process";
import { pathToFileURL } from "node:url";

const REPO = "https://github.com/drmowinckels/cairn";

/**
 * The portable-zip asset the release workflow uploads. Scoop extracts an
 * archive rather than running an installer, so the bucket points here and not
 * at the NSIS setup from #318 — and because `autoupdate` rebuilds this URL
 * from `$version` alone, the name has to stay a pure function of the version.
 */
export const assetName = (version) => `Cairn-${version}-x64-portable.zip`;

// The versions this project tags. `checkver` has to accept exactly the same
// shape, or Scoop's updater reads a truncated version out of a tag that
// `buildManifest` was happy to take.
const VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;

const downloadUrl = (tag, file) => `${REPO}/releases/download/${tag}/${file}`;

export function buildManifest({ version, hash }) {
  if (!new RegExp(`^${VERSION}$`).test(version)) {
    throw new Error(
      `not a bare semver version (drop any leading "v"): ${version}`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`not a lowercase sha256 digest: ${hash}`);
  }
  return {
    version,
    description:
      "Local-first time tracker that passively detects what you're working on from OS signals.",
    homepage: REPO,
    license: "Apache-2.0",
    architecture: {
      "64bit": {
        url: downloadUrl(`v${version}`, assetName(version)),
        hash,
      },
    },
    bin: "Cairn.exe",
    shortcuts: [["Cairn.exe", "Cairn"]],
    notes:
      "Your time entries live in %APPDATA%\\io.drmowinckels.cairn, outside the Scoop app directory — uninstalling Cairn leaves them in place.",
    // `latest` skips pre-releases, and Cairn is pre-release-only for now, so
    // read the newest release of any kind instead.
    checkver: {
      url: "https://api.github.com/repos/drmowinckels/cairn/releases?per_page=1",
      regex: String.raw`"tag_name":\s*"v(${VERSION})"`,
    },
    autoupdate: {
      architecture: {
        "64bit": {
          url: downloadUrl("v$version", assetName("$version")),
        },
      },
    },
  };
}

export const renderManifest = (manifest) =>
  `${JSON.stringify(manifest, null, 4)}\n`;

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  const [version, hash] = argv.slice(2);
  if (!version || !hash) {
    throw new Error(
      "usage: node scripts/scoop-manifest.mjs <version> <sha256>",
    );
  }
  // Resolved against this module, not the process CWD: the manifest has
  // exactly one home, and a run from the wrong directory should not quietly
  // write a second one somewhere else.
  writeFileSync(
    new URL("../bucket/cairn-timetracker.json", import.meta.url),
    renderManifest(buildManifest({ version, hash })),
    "utf8",
  );
}
