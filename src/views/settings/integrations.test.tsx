import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

const listCalendarSources = vi.fn();
const getGitWatcherStatus = vi.fn();
const getGitDiscoveryRoots = vi.fn();
const setGitDiscoveryRoots = vi.fn();
const browserExtensionStatus = vi.fn();

vi.mock("../../lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("../../lib/ipc")>(
    "../../lib/ipc",
  );
  return {
    ...actual,
    inTauri: true,
    listCalendarSources: (...args: unknown[]) => listCalendarSources(...args),
    getGitWatcherStatus: (...args: unknown[]) => getGitWatcherStatus(...args),
    getGitDiscoveryRoots: (...args: unknown[]) => getGitDiscoveryRoots(...args),
    setGitDiscoveryRoots: (...args: unknown[]) => setGitDiscoveryRoots(...args),
    browserExtensionStatus: (...args: unknown[]) =>
      browserExtensionStatus(...args),
  };
});

import {
  BrowserStatusLine,
  CalendarStatusLine,
  GitStatusLine,
} from "./integrations";
import { formatRelativeTime } from "../../lib/relative-time";

beforeEach(() => {
  listCalendarSources.mockReset();
  getGitWatcherStatus.mockReset();
  getGitDiscoveryRoots.mockReset();
  setGitDiscoveryRoots.mockReset();
  browserExtensionStatus.mockReset();
});

describe("CalendarStatusLine", () => {
  it("counts enabled sources and reports the freshest sync time", async () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    const older = new Date(Date.now() - 60 * 60_000).toISOString();
    listCalendarSources.mockResolvedValue([
      {
        id: "1",
        kind: "url",
        label: "Work",
        location: "https://example.com/work.ics",
        pollSeconds: 900,
        enabled: true,
        lastSyncedAt: older,
        lastEtag: null,
        lastModified: null,
        lastError: null,
      },
      {
        id: "2",
        kind: "url",
        label: "Personal",
        location: "https://example.com/personal.ics",
        pollSeconds: 900,
        enabled: true,
        lastSyncedAt: recent,
        lastEtag: null,
        lastModified: null,
        lastError: null,
      },
      {
        id: "3",
        kind: "file",
        label: "Disabled",
        location: "/tmp/cal.ics",
        pollSeconds: 900,
        enabled: false,
        lastSyncedAt: null,
        lastEtag: null,
        lastModified: null,
        lastError: null,
      },
    ]);

    render(
      <ul>
        <CalendarStatusLine onManage={() => {}} />
      </ul>,
    );

    await waitFor(() =>
      expect(screen.getByText(/2 sources/)).toBeTruthy(),
    );
    expect(screen.getByText(/last sync 5m ago/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Manage…/ })).toBeTruthy();
  });

  it("shows an empty state when there are no enabled sources", async () => {
    listCalendarSources.mockResolvedValue([]);
    render(
      <ul>
        <CalendarStatusLine onManage={() => {}} />
      </ul>,
    );
    await waitFor(() => expect(screen.getByText("No sources yet")).toBeTruthy());
  });

  it("matches snapshot for a single source", async () => {
    const synced = new Date(Date.now() - 2 * 60_000).toISOString();
    listCalendarSources.mockResolvedValue([
      {
        id: "1",
        kind: "url",
        label: "Work",
        location: "https://example.com/work.ics",
        pollSeconds: 900,
        enabled: true,
        lastSyncedAt: synced,
        lastEtag: null,
        lastModified: null,
        lastError: null,
      },
    ]);
    const { container } = render(
      <ul>
        <CalendarStatusLine onManage={() => {}} />
      </ul>,
    );
    await waitFor(() => screen.getByText(/1 source ·/));
    expect(container.querySelector('[data-integration="calendar"]'))
      .toMatchSnapshot();
  });
});

describe("GitStatusLine", () => {
  it("renders the watched count and discovery root", async () => {
    getGitWatcherStatus.mockResolvedValue({
      discoveryRoots: ["~/code"],
      watchedCount: 4,
    });
    render(
      <ul>
        <GitStatusLine />
      </ul>,
    );
    await waitFor(() =>
      expect(screen.getByText("Watching 4 repos under ~/code")).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: /Configure roots…/ })).toBeTruthy();
  });

  it("singularizes the repo count", async () => {
    getGitWatcherStatus.mockResolvedValue({
      discoveryRoots: ["~/code"],
      watchedCount: 1,
    });
    render(
      <ul>
        <GitStatusLine />
      </ul>,
    );
    await waitFor(() =>
      expect(screen.getByText("Watching 1 repo under ~/code")).toBeTruthy(),
    );
  });

  it("falls back when there are no roots configured", async () => {
    getGitWatcherStatus.mockResolvedValue(null);
    render(
      <ul>
        <GitStatusLine />
      </ul>,
    );
    await waitFor(() =>
      expect(screen.getByText("Watching 0 repos under ~/code")).toBeTruthy(),
    );
  });

  it("describes multiple roots compactly", async () => {
    getGitWatcherStatus.mockResolvedValue({
      discoveryRoots: ["~/code", "~/work"],
      watchedCount: 6,
    });
    render(
      <ul>
        <GitStatusLine />
      </ul>,
    );
    await waitFor(() =>
      expect(screen.getByText("Watching 6 repos under 2 folders")).toBeTruthy(),
    );
  });

  it("matches snapshot", async () => {
    getGitWatcherStatus.mockResolvedValue({
      discoveryRoots: ["~/code"],
      watchedCount: 3,
    });
    const { container } = render(
      <ul>
        <GitStatusLine />
      </ul>,
    );
    await waitFor(() => screen.getByText("Watching 3 repos under ~/code"));
    expect(container.querySelector('[data-integration="git"]'))
      .toMatchSnapshot();
  });

  it("opens the configurator, adds a root, saves, and refreshes the status", async () => {
    const { fireEvent } = await import("@testing-library/react");
    getGitWatcherStatus.mockResolvedValue({
      discoveryRoots: ["~/code"],
      watchedCount: 2,
    });
    getGitDiscoveryRoots.mockResolvedValue(["~/code"]);
    setGitDiscoveryRoots.mockResolvedValue({
      discoveryRoots: ["~/code", "~/work"],
      watchedCount: 5,
    });

    render(
      <ul>
        <GitStatusLine />
      </ul>,
    );
    await waitFor(() =>
      screen.getByText("Watching 2 repos under ~/code"),
    );

    fireEvent.click(screen.getByRole("button", { name: /Configure roots…/ }));
    // The modal loads the current roots.
    await waitFor(() => screen.getByText("~/code"));

    fireEvent.change(screen.getByLabelText(/new discovery root/i), {
      target: { value: "~/work" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(setGitDiscoveryRoots).toHaveBeenCalledWith(["~/code", "~/work"]),
    );
    // Modal closed and the status line reflects the saved result.
    await waitFor(() =>
      expect(screen.getByText("Watching 5 repos under 2 folders")).toBeTruthy(),
    );
  });

  it("removes a root in the configurator before saving", async () => {
    const { fireEvent } = await import("@testing-library/react");
    getGitWatcherStatus.mockResolvedValue({
      discoveryRoots: ["~/code", "~/work"],
      watchedCount: 6,
    });
    getGitDiscoveryRoots.mockResolvedValue(["~/code", "~/work"]);
    setGitDiscoveryRoots.mockResolvedValue({
      discoveryRoots: ["~/code"],
      watchedCount: 3,
    });

    render(
      <ul>
        <GitStatusLine />
      </ul>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Configure roots…/ }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Remove ~\/work/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(setGitDiscoveryRoots).toHaveBeenCalledWith(["~/code"]),
    );
  });
});

describe("BrowserStatusLine", () => {
  it("shows 'Not installed' and an Install action when disconnected", async () => {
    browserExtensionStatus.mockResolvedValue({
      connected: false,
      lastSeen: null,
      browserLabel: null,
    });
    render(
      <ul>
        <BrowserStatusLine installHref="https://example.com/install" />
      </ul>,
    );
    await waitFor(() =>
      expect(screen.getByText("Not installed")).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: /Install…/ })).toBeTruthy();
  });

  it("shows the browser label when connected", async () => {
    browserExtensionStatus.mockResolvedValue({
      connected: true,
      lastSeen: new Date().toISOString(),
      browserLabel: "Safari",
    });
    render(
      <ul>
        <BrowserStatusLine installHref="https://example.com/install" />
      </ul>,
    );
    await waitFor(() =>
      expect(screen.getByText("Connected (Safari)")).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: /Manage…/ })).toBeTruthy();
  });

  it("renders just 'Connected' when no label is known", async () => {
    browserExtensionStatus.mockResolvedValue({
      connected: true,
      lastSeen: new Date().toISOString(),
      browserLabel: null,
    });
    render(
      <ul>
        <BrowserStatusLine installHref="https://example.com/install" />
      </ul>,
    );
    await waitFor(() => expect(screen.getByText("Connected")).toBeTruthy());
  });

  it("matches snapshot when disconnected", async () => {
    browserExtensionStatus.mockResolvedValue({
      connected: false,
      lastSeen: null,
      browserLabel: null,
    });
    const { container } = render(
      <ul>
        <BrowserStatusLine installHref="https://example.com/install" />
      </ul>,
    );
    await waitFor(() => screen.getByText("Not installed"));
    expect(container.querySelector('[data-integration="browser"]'))
      .toMatchSnapshot();
  });
});

describe("relative-time integration sanity", () => {
  it("the calendar line uses formatRelativeTime", () => {
    const earlier = new Date(Date.now() - 2 * 60_000);
    expect(formatRelativeTime(earlier.toISOString())).toBe("2m ago");
  });
});
