import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { UpcomingList, type UpcomingEvent } from "./upcoming-list";

afterEach(() => {
  vi.clearAllMocks();
});

function event(overrides: Partial<UpcomingEvent> = {}): UpcomingEvent {
  return {
    uid: "u1",
    summary: "Design review",
    start: "2026-05-26T15:30:00Z",
    end: "2026-05-26T16:00:00Z",
    allDay: false,
    ...overrides,
  };
}

describe("UpcomingList", () => {
  it("renders the not-connected empty state when no calendars are connected", () => {
    render(
      <UpcomingList events={[]} calendarsConnected={false} />,
    );
    expect(screen.getByText(/no calendar connected/i)).toBeTruthy();
  });

  it("renders the soft empty state when calendars are connected but no events", () => {
    render(
      <UpcomingList events={[]} calendarsConnected />,
    );
    expect(screen.getByText(/nothing scheduled/i)).toBeTruthy();
  });

  it("each row is a focusable button labelled with summary + time", () => {
    render(
      <UpcomingList events={[event({})]} calendarsConnected />,
    );
    const btn = screen.getByRole("button", {
      name: /start timer for design review/i,
    });
    expect(btn.tagName).toBe("BUTTON");
  });

  it("clicking a row calls onStart with the event", () => {
    const onStart = vi.fn();
    render(
      <UpcomingList
        events={[event({})]}
        onStart={onStart}
        calendarsConnected
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /start timer for design review/i }),
    );
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart.mock.calls[0][0].uid).toBe("u1");
  });

  it("all-day events show 'all day' instead of a clock time", () => {
    render(
      <UpcomingList
        events={[event({ allDay: true })]}
        calendarsConnected
      />,
    );
    expect(screen.getByText(/all day/i)).toBeTruthy();
  });

  it("renders summary as '(no title)' fallback when empty", () => {
    render(
      <UpcomingList
        events={[event({ summary: "" })]}
        calendarsConnected
      />,
    );
    expect(screen.getByText(/no title/i)).toBeTruthy();
  });
});
