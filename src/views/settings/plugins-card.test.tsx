import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const listPlugins = vi.fn();
const setPluginEnabled = vi.fn();
const billingStatus = vi.fn();

vi.mock("../../lib/ipc", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/ipc")>("../../lib/ipc");
  return {
    ...actual,
    inTauri: true,
    listPlugins: (...args: unknown[]) => listPlugins(...args),
    setPluginEnabled: (...args: unknown[]) => setPluginEnabled(...args),
    billingStatus: (...args: unknown[]) => billingStatus(...args),
  };
});

import { PluginsCard } from "./plugins-card";

const weather = {
  id: "weather",
  name: "Weather",
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
  billingStatus.mockReset();
});

describe("PluginsCard", () => {
  it("lists each plugin with its capability badges and a switch", async () => {
    listPlugins.mockResolvedValue([weather]);
    render(<PluginsCard />);

    const sw = await screen.findByRole("switch", { name: "Enable Weather" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Weather")).toBeTruthy();
    expect(screen.getByText("Network")).toBeTruthy();
    expect(screen.getByText("Secrets")).toBeTruthy();
  });

  it("hides the calendar plugin (it lives under Integrations)", async () => {
    const calendarPlugin = {
      id: "calendar",
      name: "Calendar",
      capabilities: ["network", "secrets"] as const,
      enabled: true,
    };
    // Calendar alone ⇒ the filtered list is empty ⇒ the card renders nothing.
    listPlugins.mockResolvedValue([calendarPlugin]);
    const { container } = render(<PluginsCard />);
    await waitFor(() => expect(listPlugins).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();

    // Alongside another plugin, calendar is omitted but the other still shows.
    listPlugins.mockResolvedValue([calendarPlugin, weather]);
    render(<PluginsCard />);
    expect(await screen.findByText("Weather")).toBeTruthy();
    expect(screen.queryByText("Calendar")).toBeNull();
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
    listPlugins.mockResolvedValue([weather, browser]);
    setPluginEnabled.mockResolvedValue([
      { ...weather, enabled: false },
      browser,
    ]);
    render(<PluginsCard />);

    const sw = await screen.findByRole("switch", { name: "Enable Weather" });
    await userEvent.click(sw);

    expect(setPluginEnabled).toHaveBeenCalledWith("weather", false);
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
    listPlugins.mockResolvedValue([weather]);
    setPluginEnabled.mockResolvedValue([]);
    render(<PluginsCard />);

    const sw = await screen.findByRole("switch", { name: "Enable Weather" });
    await userEvent.click(sw);
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("false"));
  });

  it("reverts the switch and shows an error when the toggle fails", async () => {
    listPlugins.mockResolvedValue([weather, browser]);
    setPluginEnabled.mockRejectedValue(new Error("keychain locked"));
    render(<PluginsCard />);

    const sw = await screen.findByRole("switch", { name: "Enable Weather" });
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
    resolve([weather]);
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

  it("lists billing with Pro + Network badges and no license row while disabled (#109)", async () => {
    listPlugins.mockResolvedValue([
      {
        id: "billing",
        name: "Billing (Pro)",
        capabilities: ["paid", "network"] as const,
        enabled: false,
      },
    ]);
    render(<PluginsCard />);
    const sw = await screen.findByRole("switch", {
      name: "Enable Billing (Pro)",
    });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Pro")).toBeTruthy();
    expect(screen.getByText("Network")).toBeTruthy();
    expect(billingStatus).not.toHaveBeenCalled();
  });

  it("mounts the license row when billing is enabled (#109)", async () => {
    listPlugins.mockResolvedValue([
      {
        id: "billing",
        name: "Billing (Pro)",
        capabilities: ["paid", "network"] as const,
        enabled: true,
      },
    ]);
    billingStatus.mockResolvedValue({ enabled: true, license: null });
    render(<PluginsCard />);
    expect(await screen.findByLabelText(/pro license key/i)).toBeTruthy();
  });
});
