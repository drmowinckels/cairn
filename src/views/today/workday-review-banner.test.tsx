import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WorkdayReviewBanner } from "./workday-review-banner";

describe("WorkdayReviewBanner", () => {
  it("renders the offer with Review and Dismiss", () => {
    render(
      <WorkdayReviewBanner
        style="subtle"
        announce
        onReview={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /^review$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^dismiss$/i })).toBeTruthy();
  });

  it("calls onReview when Review is tapped", () => {
    const onReview = vi.fn();
    render(
      <WorkdayReviewBanner
        style="subtle"
        announce
        onReview={onReview}
        onDismiss={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^review$/i }));
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it("calls onDismiss from both the body button and the close icon", () => {
    const onDismiss = vi.fn();
    render(
      <WorkdayReviewBanner
        style="subtle"
        announce
        onReview={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^dismiss$/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /dismiss workday review reminder/i }),
    );
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("announces assertively (not as a dialog) in modal style", () => {
    render(
      <WorkdayReviewBanner
        style="modal"
        announce
        onReview={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const region = screen.getByRole("region", {
      name: /workday review reminder/i,
    });
    expect(region.getAttribute("aria-live")).toBe("assertive");
  });

  it("is a polite plain region (no dialog role) in subtle style", () => {
    render(
      <WorkdayReviewBanner
        style="subtle"
        announce
        onReview={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(
      screen
        .getByRole("region", { name: /workday review reminder/i })
        .getAttribute("aria-live"),
    ).toBe("polite");
  });

  it("turns the live region off when announcements are disabled", () => {
    render(
      <WorkdayReviewBanner
        style="modal"
        announce={false}
        onReview={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(
      screen
        .getByRole("region", { name: /workday review reminder/i })
        .getAttribute("aria-live"),
    ).toBe("off");
  });
});
