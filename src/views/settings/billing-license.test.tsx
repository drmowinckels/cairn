import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// BillingDetail owns the real `useBilling`, so its integration tests mock
// the two ipc calls that hook makes. The rate panel it mounts falls
// through to the real (out-of-Tauri ⇒ empty) list wrappers.
const billingStatus = vi.fn();
const refreshBillingLicense = vi.fn();

vi.mock("../../lib/ipc", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/ipc")>("../../lib/ipc");
  return {
    ...actual,
    billingStatus: (...a: unknown[]) => billingStatus(...a),
    refreshBillingLicense: (...a: unknown[]) => refreshBillingLicense(...a),
  };
});

import { BillingLicenseRow, BillingDetail } from "./billing-license";
import type { UseBilling } from "../../lib/use-billing";
import type { BillingStatus } from "../../lib/ipc";

const locked: BillingStatus = { enabled: true, license: null };
const active: BillingStatus = {
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
const expired: BillingStatus = {
  enabled: true,
  license: { ...active.license!, status: "expired", active: false },
};

/** A fully-stubbed `useBilling` result; override the fields a test cares
 *  about. The mutators default to resolving success. */
function makeBilling(over: Partial<UseBilling> = {}): UseBilling {
  return {
    status: null,
    busy: false,
    error: null,
    activate: vi.fn().mockResolvedValue(true),
    refresh: vi.fn().mockResolvedValue(undefined),
    deactivate: vi.fn().mockResolvedValue(true),
    ...over,
  };
}

beforeEach(() => {
  billingStatus.mockReset();
  refreshBillingLicense.mockReset();
});

describe("BillingLicenseRow", () => {
  it("renders nothing while the status is still loading", () => {
    const { container } = render(
      <BillingLicenseRow billing={makeBilling({ status: null })} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows a load failure instead of silently rendering nothing", () => {
    render(
      <BillingLicenseRow
        billing={makeBilling({ status: null, error: "ipc down" })}
      />,
    );
    expect(screen.getByText(/load the license status/i).textContent).toContain(
      "ipc down",
    );
  });

  it("activates a pasted key, notes the network call, and clears the input", async () => {
    const activate = vi.fn().mockResolvedValue(true);
    render(
      <BillingLicenseRow billing={makeBilling({ status: locked, activate })} />,
    );
    const input = screen.getByLabelText(/pro license key/i);
    expect(screen.getByText(/checks the key with lemon squeezy/i)).toBeTruthy();
    await userEvent.type(input, "KEY-1");
    await userEvent.click(screen.getByRole("button", { name: /activate/i }));
    expect(activate).toHaveBeenCalledWith("KEY-1");
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(""));
  });

  it("keeps the pasted key and shows the reason when activation is rejected", async () => {
    const activate = vi.fn().mockResolvedValue(false);
    render(
      <BillingLicenseRow
        billing={makeBilling({
          status: locked,
          activate,
          error: "license_key has reached its activation limit",
        })}
      />,
    );
    const input = screen.getByLabelText(/pro license key/i);
    await userEvent.type(input, "KEY-1{Enter}");
    expect(activate).toHaveBeenCalledWith("KEY-1");
    expect(screen.getByRole("alert").textContent).toContain("activation limit");
    expect((input as HTMLInputElement).value).toBe("KEY-1");
  });

  it("keeps Activate disabled for a blank key", () => {
    render(<BillingLicenseRow billing={makeBilling({ status: locked })} />);
    expect(
      (screen.getByRole("button", { name: /activate/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("shows the licensed state and re-check / remove call through", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const deactivate = vi.fn().mockResolvedValue(true);
    render(
      <BillingLicenseRow
        billing={makeBilling({ status: active, refresh, deactivate })}
      />,
    );
    expect(screen.getByText(/dev@example\.com/)).toBeTruthy();
    expect(screen.getByText(/checked with lemon squeezy/i)).toBeTruthy();
    expect(screen.queryByLabelText(/pro license key/i)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /re-check/i }));
    expect(refresh).toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: /remove license/i }),
    );
    expect(deactivate).toHaveBeenCalled();
  });

  it("shows an inactive license with its status and keeps it removable", () => {
    render(<BillingLicenseRow billing={makeBilling({ status: expired })} />);
    expect(screen.getByText(/no longer active \(expired\)/i)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /remove license/i }),
    ).toBeTruthy();
  });

  it("surfaces the checking indicator while a call is in flight", () => {
    render(
      <BillingLicenseRow
        billing={makeBilling({ status: active, busy: true })}
      />,
    );
    expect(screen.getByText(/checking with lemon squeezy/i)).toBeTruthy();
  });
});

describe("BillingDetail", () => {
  it("reveals the rate panel once the license is active", async () => {
    billingStatus.mockResolvedValue(active);
    refreshBillingLicense.mockResolvedValue(active);
    render(<BillingDetail />);
    expect(await screen.findByRole("heading", { name: "Rates" })).toBeTruthy();
    expect(await screen.findByText(/no rates yet/i)).toBeTruthy();
  });

  it("keeps the rate panel hidden while unlicensed", async () => {
    billingStatus.mockResolvedValue(locked);
    render(<BillingDetail />);
    await screen.findByLabelText(/pro license key/i);
    expect(screen.queryByRole("heading", { name: "Rates" })).toBeNull();
    expect(refreshBillingLicense).not.toHaveBeenCalled();
  });
});
