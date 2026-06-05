import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const listPlugins = vi.fn();
const setPluginEnabled = vi.fn();

vi.mock("../../lib/ipc", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/ipc")>("../../lib/ipc");
  return {
    ...actual,
    inTauri: true,
    listPlugins: (...args: unknown[]) => listPlugins(...args),
    setPluginEnabled: (...args: unknown[]) => setPluginEnabled(...args),
  };
});

import { PluginsCard } from "./plugins-card";

const calendar = {
  id: "calendar",
  name: "Calendar",
  capabilities: ["network", "secrets"] as const,
  enabled: true,
};

// A second plugin so the optimistic-update map has a non-matching row to
// skip (covers the `: p` arm in usePlugins).
const browser = {
  id: "browser",
  name: "Browser",
  capabilities: ["network"] as const,
  enabled: false,
};

beforeEach(() => {
  listPlugins.mockReset();
  setPluginEnabled.mockReset();
});

describe("PluginsCard", () => {
  it("lists each plugin with its capability badges and a switch", async () => {
    listPlugins.mockResolvedValue([calendar]);
    render(<PluginsCard />);

    const sw = await screen.findByRole("switch", { name: "Enable Calendar" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Calendar")).toBeTruthy();
    expect(screen.getByText("Network")).toBeTruthy();
    expect(screen.getByText("Secrets")).toBeTruthy();
  });

  it("renders a Local badge when a plugin declares no capabilities", async () => {
    listPlugins.mockResolvedValue([
      { id: "x", name: "Local Thing", capabilities: [], enabled: true },
    ]);
    render(<PluginsCard />);
    expect(await screen.findByText("Local")).toBeTruthy();
  });

  it("renders nothing when there are no plugins", async () => {
    listPlugins.mockResolvedValue([]);
    const { container } = render(<PluginsCard />);
    await waitFor(() => expect(listPlugins).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it("toggles a plugin off and reflects the backend's updated list", async () => {
    listPlugins.mockResolvedValue([calendar, browser]);
    setPluginEnabled.mockResolvedValue([
      { ...calendar, enabled: false },
      browser,
    ]);
    render(<PluginsCard />);

    const sw = await screen.findByRole("switch", { name: "Enable Calendar" });
    await userEvent.click(sw);

    expect(setPluginEnabled).toHaveBeenCalledWith("calendar", false);
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("false"));
    // The other plugin is untouched.
    expect(
      screen
        .getByRole("switch", { name: "Enable Browser" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("keeps the optimistic state when the backend returns no list", async () => {
    // Outside Tauri `setPluginEnabled` resolves `[]`; the switch must
    // hold its optimistic flip rather than blanking the list.
    listPlugins.mockResolvedValue([calendar]);
    setPluginEnabled.mockResolvedValue([]);
    render(<PluginsCard />);

    const sw = await screen.findByRole("switch", { name: "Enable Calendar" });
    await userEvent.click(sw);
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("false"));
  });

  it("reverts the switch and shows an error when the toggle fails", async () => {
    listPlugins.mockResolvedValue([calendar, browser]);
    setPluginEnabled.mockRejectedValue(new Error("keychain locked"));
    render(<PluginsCard />);

    const sw = await screen.findByRole("switch", { name: "Enable Calendar" });
    await userEvent.click(sw);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("keychain locked");
    // Optimistic flip reverted back to enabled; the other row is untouched.
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
    expect(
      screen
        .getByRole("switch", { name: "Enable Browser" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("surfaces a load failure instead of hiding silently", async () => {
    listPlugins.mockRejectedValue(new Error("backend down"));
    render(<PluginsCard />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn’t load plugins");
    expect(alert.textContent).toContain("backend down");
  });

  it("ignores a load that resolves after unmount", async () => {
    // Unmount before the load settles: the cancelled guard must skip the
    // post-unmount setState (no warning, no crash).
    let resolve!: (v: unknown) => void;
    listPlugins.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { unmount } = render(<PluginsCard />);
    unmount();
    resolve([calendar]);
    await waitFor(() => expect(listPlugins).toHaveBeenCalled());
  });

  it("ignores a load that rejects after unmount", async () => {
    let reject!: (e: unknown) => void;
    listPlugins.mockReturnValue(
      new Promise((_resolve, rej) => {
        reject = rej;
      }),
    );
    const { unmount } = render(<PluginsCard />);
    unmount();
    reject(new Error("late"));
    await waitFor(() => expect(listPlugins).toHaveBeenCalled());
  });
});
