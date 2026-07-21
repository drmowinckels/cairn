import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const billingStatus = vi.fn();
const setBillingLicense = vi.fn();
const clearBillingLicense = vi.fn();

vi.mock("../../lib/ipc", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/ipc")>("../../lib/ipc");
  return {
    ...actual,
    billingStatus: (...args: unknown[]) => billingStatus(...args),
    setBillingLicense: (...args: unknown[]) => setBillingLicense(...args),
    clearBillingLicense: (...args: unknown[]) => clearBillingLicense(...args),
  };
});

import { BillingLicenseRow } from "./billing-license";

const locked = { enabled: true, keyConfigured: true, license: null };
const licensed = {
  enabled: true,
  keyConfigured: true,
  license: { email: "dev@example.com", orderId: "o1", product: "cairn-pro" },
};

beforeEach(() => {
  billingStatus.mockReset();
  setBillingLicense.mockReset();
  clearBillingLicense.mockReset();
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
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn’t load the license status");
    expect(alert.textContent).toContain("ipc down");
  });

  it("explains when the build has no license key", async () => {
    billingStatus.mockResolvedValue({
      enabled: true,
      keyConfigured: false,
      license: null,
    });
    render(<BillingLicenseRow />);
    expect(
      await screen.findByText(/isn.t available in this build/i),
    ).toBeTruthy();
    expect(screen.queryByLabelText(/pro license key/i)).toBeNull();
  });

  it("activates a pasted key and clears the input on success", async () => {
    billingStatus.mockResolvedValue(locked);
    setBillingLicense.mockResolvedValue(licensed);
    render(<BillingLicenseRow />);

    const input = await screen.findByLabelText(/pro license key/i);
    await userEvent.type(input, "payload.sig");
    await userEvent.click(screen.getByRole("button", { name: /activate/i }));

    await screen.findByText(/dev@example\.com/);
    expect(setBillingLicense).toHaveBeenCalledWith("payload.sig");
    expect(screen.getByText(/never online/i)).toBeTruthy();
    // The input is gone (licensed state), not just cleared.
    expect(screen.queryByLabelText(/pro license key/i)).toBeNull();
  });

  it("keeps the pasted key and shows the error when activation fails", async () => {
    billingStatus.mockResolvedValue(locked);
    setBillingLicense.mockRejectedValue("license signature does not match");
    render(<BillingLicenseRow />);

    const input = await screen.findByLabelText(/pro license key/i);
    await userEvent.type(input, "bad.key{Enter}");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("does not match");
    expect((input as HTMLInputElement).value).toBe("bad.key");
  });

  it("Activate stays disabled for a blank key", async () => {
    billingStatus.mockResolvedValue(locked);
    render(<BillingLicenseRow />);
    const btn = await screen.findByRole("button", { name: /activate/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("removes the license from the licensed state", async () => {
    billingStatus.mockResolvedValue(licensed);
    clearBillingLicense.mockResolvedValue(locked);
    render(<BillingLicenseRow />);

    await userEvent.click(
      await screen.findByRole("button", { name: /remove license/i }),
    );
    await waitFor(() =>
      expect(screen.queryByText(/dev@example\.com/)).toBeNull(),
    );
    expect(screen.getByLabelText(/pro license key/i)).toBeTruthy();
  });

  it("surfaces a remove failure as an alert", async () => {
    billingStatus.mockResolvedValue(licensed);
    clearBillingLicense.mockRejectedValue("db locked");
    render(<BillingLicenseRow />);

    await userEvent.click(
      await screen.findByRole("button", { name: /remove license/i }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("db locked");
  });
});
