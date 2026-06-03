import { describe, expect, it } from "vitest";
import {
  backupHealth,
  backupHealthMessage,
  type BackupHealth,
} from "./backup-staleness";
import type { AutoBackupSettings, AutoBackupStatus } from "./ipc";

const NOW = new Date("2026-06-03T12:00:00Z");

function settings(over: Partial<AutoBackupSettings> = {}): AutoBackupSettings {
  return {
    enabled: true,
    dir: "/sync/cairn",
    intervalHours: 24,
    keep: 14,
    ...over,
  };
}

function status(over: Partial<AutoBackupStatus> = {}): AutoBackupStatus {
  return { lastBackupAt: NOW.toISOString(), count: 3, ...over };
}

describe("backupHealth", () => {
  it("is 'off' when automatic backup is disabled", () => {
    expect(backupHealth(settings({ enabled: false }), status(), NOW)).toBe(
      "off",
    );
  });

  it("is 'off' when no folder is configured", () => {
    expect(backupHealth(settings({ dir: null }), status(), NOW)).toBe("off");
  });

  it("is 'never' when enabled+configured but no snapshots exist", () => {
    expect(
      backupHealth(settings(), status({ count: 0, lastBackupAt: null }), NOW),
    ).toBe("never");
  });

  it("is 'never' when the last-backup timestamp is null despite a count", () => {
    expect(
      backupHealth(settings(), status({ count: 3, lastBackupAt: null }), NOW),
    ).toBe("never");
  });

  it("is 'never' when the last-backup timestamp is unparseable", () => {
    expect(
      backupHealth(settings(), status({ lastBackupAt: "not-a-date" }), NOW),
    ).toBe("never");
  });

  it("is 'stale' when the last backup is older than twice the interval", () => {
    // interval 24h → stale after 48h. 49h ago is stale.
    const last = new Date(NOW.getTime() - 49 * 60 * 60 * 1000).toISOString();
    expect(backupHealth(settings(), status({ lastBackupAt: last }), NOW)).toBe(
      "stale",
    );
  });

  it("is 'ok' just under the 2× interval boundary", () => {
    // 47h ago, interval 24h (threshold 48h) → still ok.
    const last = new Date(NOW.getTime() - 47 * 60 * 60 * 1000).toISOString();
    expect(backupHealth(settings(), status({ lastBackupAt: last }), NOW)).toBe(
      "ok",
    );
  });

  it("treats exactly 2× interval as ok (boundary is strictly greater-than)", () => {
    const last = new Date(NOW.getTime() - 48 * 60 * 60 * 1000).toISOString();
    expect(backupHealth(settings(), status({ lastBackupAt: last }), NOW)).toBe(
      "ok",
    );
  });

  it("is 'ok' for a fresh backup", () => {
    expect(backupHealth(settings(), status(), NOW)).toBe("ok");
  });

  it("defaults `now` to the current time when omitted", () => {
    const last = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(backupHealth(settings(), status({ lastBackupAt: last }))).toBe("ok");
  });
});

describe("backupHealthMessage", () => {
  it("returns null for 'off'", () => {
    expect(backupHealthMessage("off", status(), NOW)).toBeNull();
  });

  it("returns null for 'ok'", () => {
    expect(backupHealthMessage("ok", status(), NOW)).toBeNull();
  });

  it("explains the 'never' state", () => {
    expect(backupHealthMessage("never", status(), NOW)).toBe(
      "No backup taken yet.",
    );
  });

  it("includes a relative age and a check-folder hint for 'stale'", () => {
    const last = new Date(NOW.getTime() - 49 * 60 * 60 * 1000).toISOString();
    const msg = backupHealthMessage(
      "stale",
      status({ lastBackupAt: last }),
      NOW,
    );
    expect(msg).toMatch(/2d ago/);
    expect(msg).toMatch(/check your backup folder is reachable/);
  });

  it("defaults `now` to the current time when omitted", () => {
    const last = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
    const msg = backupHealthMessage(
      "stale" as BackupHealth,
      status({ lastBackupAt: last }),
    );
    expect(msg).toMatch(/check your backup folder is reachable/);
  });
});
