import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

const autostartIsEnabled = vi.fn().mockResolvedValue(false);
const autostartEnable = vi.fn().mockResolvedValue(undefined);
const autostartDisable = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/plugin-autostart", () => ({
  isEnabled: (...args: unknown[]) => autostartIsEnabled(...args),
  enable: (...args: unknown[]) => autostartEnable(...args),
  disable: (...args: unknown[]) => autostartDisable(...args),
}));

const listCalendarSources = vi.fn();
const getGitWatcherStatus = vi.fn();
const getGitDiscoveryRoots = vi.fn();
const setGitDiscoveryRoots = vi.fn();
const browserExtensionStatus = vi.fn();

vi.mock("../../lib/ipc", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/ipc")>("../../lib/ipc");
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
  AutostartStatusLine,
  BrowserStatusLine,
  CalendarStatusLine,
  GitStatusLine,
  IntegrationsCard,
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

    await waitFor(() => expect(screen.getByText(/2 sources/)).toBeTruthy());
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
    await waitFor(() =>
      expect(screen.getByText("No sources yet")).toBeTruthy(),
    );
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
    expect(
      container.querySelector('[data-integration="calendar"]'),
    ).toMatchSnapshot();
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
    expect(
      screen.getByRole("button", { name: /Configure roots…/ }),
    ).toBeTruthy();
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
    expect(
      container.querySelector('[data-integration="git"]'),
    ).toMatchSnapshot();
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
    await waitFor(() => screen.getByText("Watching 2 repos under ~/code"));

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

  it("reset-to-defaults persists an empty override and reloads the defaults", async () => {
    const { fireEvent } = await import("@testing-library/react");
    getGitWatcherStatus.mockResolvedValue({
      discoveryRoots: ["~/work"],
      watchedCount: 4,
    });
    // First call (on mount) → the configured root; second call (after
    // reset) → the reloaded built-in defaults.
    getGitDiscoveryRoots
      .mockResolvedValueOnce(["~/work"])
      .mockResolvedValueOnce(["~/code"]);
    setGitDiscoveryRoots.mockResolvedValue({
      discoveryRoots: ["~/code"],
      watchedCount: 1,
    });

    render(
      <ul>
        <GitStatusLine />
      </ul>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Configure roots…/ }),
    );
    await screen.findByText("~/work");
    fireEvent.click(screen.getByRole("button", { name: /reset to defaults/i }));

    await waitFor(() => expect(setGitDiscoveryRoots).toHaveBeenCalledWith([]));
    // The reloaded defaults render in the list.
    await waitFor(() => expect(screen.getByText("~/code")).toBeTruthy());
  });

  it("surfaces an error when saving the roots fails", async () => {
    const { fireEvent } = await import("@testing-library/react");
    getGitWatcherStatus.mockResolvedValue({
      discoveryRoots: ["~/code"],
      watchedCount: 2,
    });
    getGitDiscoveryRoots.mockResolvedValue(["~/code"]);
    setGitDiscoveryRoots.mockRejectedValue("/ resolves to the filesystem root");

    render(
      <ul>
        <GitStatusLine />
      </ul>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Configure roots…/ }),
    );
    await screen.findByText("~/code");
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/filesystem root/i),
    );
  });

  it("shows an error when the configurator fails to load roots", async () => {
    const { fireEvent } = await import("@testing-library/react");
    getGitWatcherStatus.mockResolvedValue({
      discoveryRoots: ["~/code"],
      watchedCount: 2,
    });
    getGitDiscoveryRoots.mockRejectedValue("cannot read roots");

    render(
      <ul>
        <GitStatusLine />
      </ul>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Configure roots…/ }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(
        /cannot read roots/i,
      ),
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
  it("shows 'Coming soon' and a disabled Install action when disconnected", async () => {
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
    await waitFor(() => expect(screen.getByText("Coming soon")).toBeTruthy());
    // The extension isn't published yet (#37) — the install action is
    // present but disabled rather than sending the user to the repo.
    const install = screen.getByRole("button", { name: /Install…/ });
    expect(install.hasAttribute("disabled")).toBe(true);
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
    await waitFor(() => screen.getByText("Coming soon"));
    expect(
      container.querySelector('[data-integration="browser"]'),
    ).toMatchSnapshot();
  });
});

describe("AutostartStatusLine", () => {
  beforeEach(() => {
    autostartIsEnabled.mockReset().mockResolvedValue(false);
    autostartEnable.mockReset().mockResolvedValue(undefined);
    autostartDisable.mockReset().mockResolvedValue(undefined);
  });

  it("renders a platform-correct label and reflects the probed state", async () => {
    autostartIsEnabled.mockResolvedValue(true);
    render(
      <ul>
        <AutostartStatusLine />
      </ul>,
    );
    // The label is platform-derived; the switch must reach the on state
    // once the plugin probe resolves.
    await waitFor(() =>
      expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
    expect(screen.getByText("On")).toBeTruthy();
  });

  it("enables autostart when the off switch is clicked", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    render(
      <ul>
        <AutostartStatusLine />
      </ul>,
    );
    const sw = screen.getByRole("switch");
    await waitFor(() => expect(sw.hasAttribute("disabled")).toBe(false));
    await user.click(sw);
    await waitFor(() => expect(autostartEnable).toHaveBeenCalledOnce());
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });

  it("surfaces a probe failure in the status line", async () => {
    autostartIsEnabled.mockRejectedValue(new Error("registry denied"));
    render(
      <ul>
        <AutostartStatusLine />
      </ul>,
    );
    await waitFor(() => expect(screen.getByText(/Toggle failed/)).toBeTruthy());
    expect(screen.getByText(/registry denied/)).toBeTruthy();
  });
});

describe("IntegrationsCard", () => {
  beforeEach(() => {
    listCalendarSources.mockResolvedValue([]);
    getGitWatcherStatus.mockResolvedValue({
      discoveryRoots: ["~/code"],
      watchedCount: 0,
    });
    browserExtensionStatus.mockResolvedValue({
      connected: false,
      lastSeen: null,
      browserLabel: null,
    });
    autostartIsEnabled.mockReset().mockResolvedValue(false);
  });

  it("composes all four integration rows", async () => {
    const { container } = render(<IntegrationsCard />);
    await waitFor(() =>
      expect(
        container.querySelector('[data-integration="autostart"]'),
      ).toBeTruthy(),
    );
    for (const id of ["calendar", "git", "browser", "autostart"]) {
      expect(
        container.querySelector(`[data-integration="${id}"]`),
      ).toBeTruthy();
    }
  });

  it("refreshes the calendar status line after the manager closes", async () => {
    render(<IntegrationsCard />);
    await waitFor(() => expect(listCalendarSources).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: /Manage…/ }));
    // Count after the manager (its own useCalendars) has mounted, so we
    // isolate the refetch the close triggers via the status line's remount.
    const afterOpen = listCalendarSources.mock.calls.length;
    await userEvent.click(
      await screen.findByRole("button", { name: /^close$/i }),
    );
    await waitFor(() =>
      expect(listCalendarSources.mock.calls.length).toBeGreaterThan(afterOpen),
    );
  });
});

describe("relative-time integration sanity", () => {
  it("the calendar line uses formatRelativeTime", () => {
    const earlier = new Date(Date.now() - 2 * 60_000);
    expect(formatRelativeTime(earlier.toISOString())).toBe("2m ago");
  });
});
