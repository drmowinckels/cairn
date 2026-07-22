import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const billingStatus = vi.fn();
const activateBillingLicense = vi.fn();
const refreshBillingLicense = vi.fn();
const deactivateBillingLicense = vi.fn();

vi.mock("../../lib/ipc", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/ipc")>("../../lib/ipc");
  return {
    ...actual,
    billingStatus: (...a: unknown[]) => billingStatus(...a),
    activateBillingLicense: (...a: unknown[]) => activateBillingLicense(...a),
    refreshBillingLicense: (...a: unknown[]) => refreshBillingLicense(...a),
    deactivateBillingLicense: (...a: unknown[]) =>
      deactivateBillingLicense(...a),
  };
});

import { BillingLicenseRow } from "./billing-license";

const locked = { enabled: true, license: null };
const active = {
  enabled: true,
  license: {
    status: "active",
    active: true,
    customerEmail: "dev@example.com",
    productName: "Cairn Pro",
    expiresAt: null,
    lastValidatedAt: "2026-07-22T00:00:00Z",
  },
};
const expired = {
  enabled: true,
  license: { ...active.license, status: "expired", active: false },
};

beforeEach(() => {
  billingStatus.mockReset();
  activateBillingLicense.mockReset();
  refreshBillingLicense.mockReset();
  deactivateBillingLicense.mockReset();
});

describe("BillingLicenseRow", () => {
  it("renders nothing while the status loads", () => {
    billingStatus.mockReturnValue(new Promise(() => {}));
    const { container } = render(<BillingLicenseRow />);
    expect(container.firstChild).toBeNull();
  });

  it("shows a load failure instead of silently rendering nothing", async () => {
    billingStatus.mockRejectedValue(new Error("ipc down"));
    render(<BillingLicenseRow />);
    const alert = await screen.findByText(/load the license status/i);
    expect(alert.textContent).toContain("ipc down");
  });

  it("activates a pasted key, notes the network call, and clears the input", async () => {
    billingStatus.mockResolvedValue(locked);
    activateBillingLicense.mockResolvedValue(active);
    render(<BillingLicenseRow />);

    const input = await screen.findByLabelText(/pro license key/i);
    expect(screen.getByText(/checks the key with lemon squeezy/i)).toBeTruthy();
    await userEvent.type(input, "KEY-1");
    await userEvent.click(screen.getByRole("button", { name: /activate/i }));

    await screen.findByText(/dev@example\.com/);
    expect(activateBillingLicense).toHaveBeenCalledWith("KEY-1");
    expect(screen.queryByLabelText(/pro license key/i)).toBeNull();
  });

  it("keeps the pasted key and shows Lemon Squeezy's reason on rejection", async () => {
    billingStatus.mockResolvedValue(locked);
    activateBillingLicense.mockRejectedValue(
      "license_key has reached its activation limit",
    );
    render(<BillingLicenseRow />);

    const input = await screen.findByLabelText(/pro license key/i);
    await userEvent.type(input, "KEY-1{Enter}");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("activation limit");
    expect((input as HTMLInputElement).value).toBe("KEY-1");
  });

  it("re-checks a stored license on mount and shows the licensed state", async () => {
    billingStatus.mockResolvedValue(active);
    refreshBillingLicense.mockResolvedValue(active);
    render(<BillingLicenseRow />);

    await screen.findByText(/dev@example\.com/);
    await waitFor(() => expect(refreshBillingLicense).toHaveBeenCalled());
    expect(screen.getByText(/checked with lemon squeezy/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /re-check/i })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /remove license/i }),
    ).toBeTruthy();
    expect(screen.queryByLabelText(/pro license key/i)).toBeNull();
  });

  it("shows an inactive license with its status and keeps it removable", async () => {
    billingStatus.mockResolvedValue(expired);
    refreshBillingLicense.mockResolvedValue(expired);
    render(<BillingLicenseRow />);

    expect(
      await screen.findByText(/no longer active \(expired\)/i),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /remove license/i }),
    ).toBeTruthy();
  });

  it("removes (deactivates) the license", async () => {
    billingStatus.mockResolvedValue(active);
    refreshBillingLicense.mockResolvedValue(active);
    deactivateBillingLicense.mockResolvedValue(locked);
    render(<BillingLicenseRow />);

    await userEvent.click(
      await screen.findByRole("button", { name: /remove license/i }),
    );
    await waitFor(() =>
      expect(screen.queryByText(/dev@example\.com/)).toBeNull(),
    );
    expect(screen.getByLabelText(/pro license key/i)).toBeTruthy();
  });

  it("surfaces a deactivate failure as an alert", async () => {
    billingStatus.mockResolvedValue(active);
    refreshBillingLicense.mockResolvedValue(active);
    deactivateBillingLicense.mockRejectedValue(
      "couldn't release this device with Lemon Squeezy",
    );
    render(<BillingLicenseRow />);

    await userEvent.click(
      await screen.findByRole("button", { name: /remove license/i }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("couldn't release this device");
  });

  it("Activate stays disabled for a blank key", async () => {
    billingStatus.mockResolvedValue(locked);
    render(<BillingLicenseRow />);
    const btn = await screen.findByRole("button", { name: /activate/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });
});
