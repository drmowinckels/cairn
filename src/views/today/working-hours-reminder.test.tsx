import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WorkingHoursReminder } from "./working-hours-reminder";

describe("WorkingHoursReminder", () => {
  it("renders the offer with Start and Dismiss", () => {
    render(
      <WorkingHoursReminder
        style="subtle"
        announce
        onStart={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /start tracking/i }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /^dismiss$/i })).toBeTruthy();
  });

  it("calls onStart when Start tracking is tapped", () => {
    const onStart = vi.fn();
    render(
      <WorkingHoursReminder
        style="subtle"
        announce
        onStart={onStart}
        onDismiss={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /start tracking/i }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("calls onDismiss from both the body button and the close icon", () => {
    const onDismiss = vi.fn();
    render(
      <WorkingHoursReminder
        style="subtle"
        announce
        onStart={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^dismiss$/i }));
    fireEvent.click(screen.getByRole("button", { name: /dismiss reminder/i }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("announces assertively (not as a dialog) in modal style", () => {
    render(
      <WorkingHoursReminder
        style="modal"
        announce
        onStart={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    // "modal" is visual only — a live region, never an actual dialog.
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const region = screen.getByRole("region", {
      name: /start tracking reminder/i,
    });
    expect(region.getAttribute("aria-live")).toBe("assertive");
  });

  it("is a polite plain region (no dialog role) in subtle style", () => {
    render(
      <WorkingHoursReminder
        style="subtle"
        announce
        onStart={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(
      screen
        .getByRole("region", { name: /start tracking reminder/i })
        .getAttribute("aria-live"),
    ).toBe("polite");
  });
});
