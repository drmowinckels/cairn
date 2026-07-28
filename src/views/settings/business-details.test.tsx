import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const useBusiness = vi.fn();
vi.mock("../../lib/use-business", () => ({
  useBusiness: () => useBusiness(),
}));

import { BusinessDetailsPanel } from "./business-details";

const details = (over: Record<string, unknown> = {}) => ({
  name: "Acme AS",
  address: "123 Main\nOslo",
  email: "hi@acme.no",
  taxId: "NO 1",
  ...over,
});

function state(over: Partial<ReturnType<typeof useBusiness>> = {}) {
  return {
    details: details(),
    busy: false,
    error: null,
    saved: false,
    save: vi.fn().mockResolvedValue(details()),
    clearSaved: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  useBusiness.mockReset();
});

describe("BusinessDetailsPanel", () => {
  it("shows loading until details arrive, then seeds the form", () => {
    useBusiness.mockReturnValue(state({ details: null }));
    const { rerender } = render(<BusinessDetailsPanel />);
    expect(screen.getByText(/loading/i)).toBeTruthy();

    useBusiness.mockReturnValue(state());
    rerender(<BusinessDetailsPanel />);
    expect(
      (screen.getByLabelText(/business name/i) as HTMLInputElement).value,
    ).toBe("Acme AS");
    expect(
      (screen.getByLabelText(/^address$/i) as HTMLTextAreaElement).value,
    ).toBe("123 Main\nOslo");
  });

  it("surfaces a load failure instead of a permanent loading state", () => {
    useBusiness.mockReturnValue(
      state({ details: null, error: "the billing plugin is off" }),
    );
    render(<BusinessDetailsPanel />);
    expect(screen.queryByText(/loading/i)).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/plugin is off/i);
  });

  it("edits fields and saves the current form", async () => {
    const save = vi.fn().mockResolvedValue(details({ name: "New Co" }));
    const clearSaved = vi.fn();
    useBusiness.mockReturnValue(state({ save, clearSaved }));
    render(<BusinessDetailsPanel />);

    const name = screen.getByLabelText(/business name/i);
    await userEvent.clear(name);
    await userEvent.type(name, "New Co");
    // Exercise every field's edit handler.
    fireEvent.change(screen.getByLabelText(/^address$/i), {
      target: { value: "9 Oak\nBergen" },
    });
    fireEvent.change(screen.getByLabelText(/^email$/i), {
      target: { value: "new@co.no" },
    });
    fireEvent.change(screen.getByLabelText(/tax id/i), {
      target: { value: "NO 2" },
    });
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).toMatchObject({
      name: "New Co",
      address: "9 Oak\nBergen",
      email: "new@co.no",
      taxId: "NO 2",
    });
    // Not previously saved, so editing doesn't try to clear the confirmation.
    expect(clearSaved).not.toHaveBeenCalled();
  });

  it("shows the saved confirmation and clears it on the next edit", async () => {
    const clearSaved = vi.fn();
    useBusiness.mockReturnValue(state({ saved: true, clearSaved }));
    render(<BusinessDetailsPanel />);

    expect(screen.getByText(/^saved\.$/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/tax id/i), {
      target: { value: "NO 2" },
    });
    expect(clearSaved).toHaveBeenCalled();
  });

  it("disables save while a save is in flight", () => {
    useBusiness.mockReturnValue(state({ busy: true }));
    render(<BusinessDetailsPanel />);
    expect(
      (screen.getByRole("button", { name: /save/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("surfaces a save error as an alert", () => {
    useBusiness.mockReturnValue(state({ error: "Cairn Pro isn't active" }));
    render(<BusinessDetailsPanel />);
    expect(screen.getByRole("alert").textContent).toMatch(/isn't active/i);
  });
});
