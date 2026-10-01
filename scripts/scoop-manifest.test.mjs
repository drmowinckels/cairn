import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { assetName, buildManifest, renderManifest } from "./scoop-manifest.mjs";

const release = readFileSync(".github/workflows/release.yml", "utf8");
const bump = readFileSync(".github/workflows/scoop.yml", "utf8");

const HASH = "a".repeat(64);
const manifest = buildManifest({ version: "0.1.0-beta", hash: HASH });

/**
 * A Scoop manifest only ever fails on a user's machine: nothing in the build
 * reads it, so a wrong URL, a renamed binary, or a stale asset name surfaces as
 * `scoop install` exploding for someone else (#319). These tests pin the three
 * couplings that span files — the asset the release workflow uploads, the name
 * inside the zip, and the URL `autoupdate` reconstructs.
 */
describe("Scoop manifest (#319)", () => {
  it("points at the asset the release workflow actually uploads", () => {
    // Three files spell this name independently — the workflow that uploads
    // it, the workflow that downloads it to hash it, and the manifest that
    // tells Scoop where to get it. One of them drifting is a 404 that only
    // shows up on a user's machine.
    expect(release).toContain(assetName("$version"));
    expect(bump).toContain(assetName("$version"));
    expect(manifest.architecture["64bit"].url).toBe(
      "https://github.com/drmowinckels/cairn/releases/download/v0.1.0-beta/Cairn-0.1.0-beta-x64-portable.zip",
    );
  });

  it("names the binary the zip actually contains", () => {
    // The release workflow stages the Cargo output (`cairn.exe`) under the
    // product name before zipping, so `bin`/`shortcuts` must match that.
    expect(release).toMatch(/Copy-Item .*release.cairn\.exe.*Cairn\.exe/);
    expect(manifest.bin).toBe("Cairn.exe");
    expect(manifest.shortcuts).toEqual([["Cairn.exe", "Cairn"]]);
  });

  it("rebuilds the same URL from $version alone, for autoupdate", () => {
    const template = manifest.autoupdate.architecture["64bit"].url;
    expect(template.replaceAll("$version", "0.1.0-beta")).toBe(
      manifest.architecture["64bit"].url,
    );
  });

  it("tracks pre-releases, which `latest` would skip", () => {
    expect(manifest.checkver.url).toContain("releases?per_page=1");
    const tags = new RegExp(manifest.checkver.regex);
    expect('"tag_name": "v0.2.0-beta",'.match(tags)[1]).toBe("0.2.0-beta");
  });

  it("is bumped by a workflow rather than by hand", () => {
    expect(bump).toContain("scripts/scoop-manifest.mjs");
    expect(bump).toContain("bucket/cairn-timetracker.json");
  });

  it("is bumped only once the release is published", () => {
    // The tag push produces a DRAFT release, whose assets 404 for everyone but
    // the maintainer. Bumping then would publish a download nobody can fetch.
    expect(bump).toMatch(/release:\n\s+types: \[published\]/);
  });

  it("writes JSON Scoop can parse", () => {
    expect(JSON.parse(renderManifest(manifest))).toEqual(manifest);
  });

  it("refuses a version or digest Scoop would choke on", () => {
    expect(() => buildManifest({ version: "v0.1.0", hash: HASH })).toThrow(
      /leading "v"/,
    );
    expect(() => buildManifest({ version: "0.1.0", hash: "nope" })).toThrow(
      /sha256/,
    );
  });
});
