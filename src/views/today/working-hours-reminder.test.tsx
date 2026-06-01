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

  it("uses alertdialog role in modal style", () => {
    render(
      <WorkingHoursReminder
        style="modal"
        announce={false}
        onStart={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("is a plain region (no dialog role) in subtle style", () => {
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
      screen.getByRole("region", { name: /start tracking reminder/i }),
    ).toBeTruthy();
  });
});
