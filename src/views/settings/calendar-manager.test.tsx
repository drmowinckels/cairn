import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";

const calendars = {
  sources: [] as unknown[],
  loading: false,
  error: null as string | null,
  refresh: vi.fn(),
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  resync: vi.fn(),
};
vi.mock("../../lib/use-calendars", () => ({
  useCalendars: () => calendars,
  guessCalendarKind: () => "url",
}));

import { CalendarManager } from "./calendar-manager";

beforeEach(() => {
  calendars.error = null;
});

describe("CalendarManager modal a11y", () => {
  it("moves focus into the dialog on open", () => {
    const { getByRole } = render(<CalendarManager onClose={vi.fn()} />);
    expect(document.activeElement).toBe(
      getByRole("dialog", { name: /manage calendar sources/i }),
    );
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    const { getByRole } = render(<CalendarManager onClose={onClose} />);
    fireEvent.keyDown(getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes when the backdrop is pressed", () => {
    const onClose = vi.fn();
    const { container } = render(<CalendarManager onClose={onClose} />);
    const scrim = container.querySelector(".modal-scrim") as HTMLElement;
    fireEvent.mouseDown(scrim);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
