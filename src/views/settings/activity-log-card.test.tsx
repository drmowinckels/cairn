import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ActivityLogCard } from "./activity-log-card";
import type { UseActivityLog } from "../../lib/use-activity-log";
import type { UseWorkdayReviewPrefs } from "../../lib/use-workday-review-prefs";

function stub(over: Partial<UseActivityLog> = {}): UseActivityLog {
  return {
    settings: { enabled: false, retentionDays: 7, minSpanMinutes: 5 },
    error: null,
    setEnabled: vi.fn().mockResolvedValue(undefined),
    setRetentionDays: vi.fn().mockResolvedValue(undefined),
    setMinSpanMinutes: vi.fn().mockResolvedValue(undefined),
    deleteAll: vi.fn().mockResolvedValue(undefined),
    exportToFile: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

function workdayStub(
  over: Partial<UseWorkdayReviewPrefs> = {},
): UseWorkdayReviewPrefs {
  return {
    enabled: false,
    setEnabled: vi.fn(),
    ...over,
  };
}

describe("ActivityLogCard (#190)", () => {
  it("renders the section off by default with no retention row", () => {
    render(<ActivityLogCard activityLog={stub()} />);
    expect(screen.getByRole("heading", { name: /activity log/i })).toBeTruthy();
    expect(
      (
        screen.getByRole("switch", {
          name: /save activity log/i,
        }) as HTMLButtonElement
      ).getAttribute("aria-checked"),
    ).toBe("false");
    // Retention only shows while enabled.
    expect(screen.queryByLabelText(/activity log retention/i)).toBeNull();
  });

  it("enabling opens the privacy confirm and only turns on after Turn on", () => {
    const al = stub();
    render(<ActivityLogCard activityLog={al} />);
    fireEvent.click(screen.getByRole("switch", { name: /save activity log/i }));
    // Confirm dialog appears; nothing enabled yet.
    expect(screen.getByTestId("activity-confirm")).toBeTruthy();
    expect(al.setEnabled).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /turn on/i }));
    expect(al.setEnabled).toHaveBeenCalledWith(true);
  });

  it("cancelling the confirm leaves it off", () => {
    const al = stub();
    render(<ActivityLogCard activityLog={al} />);
    fireEvent.click(screen.getByRole("switch", { name: /save activity log/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.queryByTestId("activity-confirm")).toBeNull();
    expect(al.setEnabled).not.toHaveBeenCalled();
  });

  it("disabling turns off immediately (no confirm — backend purges)", () => {
    const al = stub({
      settings: { enabled: true, retentionDays: 7, minSpanMinutes: 5 },
    });
    render(<ActivityLogCard activityLog={al} />);
    fireEvent.click(screen.getByRole("switch", { name: /save activity log/i }));
    expect(al.setEnabled).toHaveBeenCalledWith(false);
    expect(screen.queryByTestId("activity-confirm")).toBeNull();
  });

  it("shows the retention dropdown when on and writes a change", () => {
    const al = stub({
      settings: { enabled: true, retentionDays: 7, minSpanMinutes: 5 },
    });
    render(<ActivityLogCard activityLog={al} />);
    const sel = screen.getByLabelText(
      /activity log retention/i,
    ) as HTMLSelectElement;
    expect(sel.value).toBe("7");
    fireEvent.change(sel, { target: { value: "0" } });
    expect(al.setRetentionDays).toHaveBeenCalledWith(0);
  });

  it("shows the minimum-activity dropdown when on and writes a change (#313)", () => {
    const al = stub({
      settings: { enabled: true, retentionDays: 7, minSpanMinutes: 5 },
    });
    render(<ActivityLogCard activityLog={al} />);
    const sel = screen.getByLabelText(
      /minimum activity length/i,
    ) as HTMLSelectElement;
    expect(sel.value).toBe("5");
    // 5 minutes is the floor — nothing shorter is offered.
    const values = [...sel.options].map((o) => o.value);
    expect(values).toEqual(["5", "10", "15", "30"]);
    fireEvent.change(sel, { target: { value: "15" } });
    expect(al.setMinSpanMinutes).toHaveBeenCalledWith(15);
  });

  it("hides the minimum-activity dropdown while the log is off (#313)", () => {
    render(<ActivityLogCard activityLog={stub()} />);
    expect(screen.queryByLabelText(/minimum activity length/i)).toBeNull();
  });

  it("Delete activity log now calls deleteAll", () => {
    const al = stub({
      settings: { enabled: true, retentionDays: 7, minSpanMinutes: 5 },
    });
    render(<ActivityLogCard activityLog={al} />);
    fireEvent.click(
      screen.getByRole("button", { name: /delete activity log/i }),
    );
    expect(al.deleteAll).toHaveBeenCalledTimes(1);
  });

  it("Export CSV shows only when on and calls exportToFile", () => {
    const off = stub();
    const { rerender } = render(<ActivityLogCard activityLog={off} />);
    expect(screen.queryByRole("button", { name: /export csv/i })).toBeNull();

    const on = stub({
      settings: { enabled: true, retentionDays: 7, minSpanMinutes: 5 },
    });
    rerender(<ActivityLogCard activityLog={on} />);
    fireEvent.click(screen.getByRole("button", { name: /export csv/i }));
    expect(on.exportToFile).toHaveBeenCalledTimes(1);
  });

  it("renders an error banner when the hook reports one", () => {
    render(<ActivityLogCard activityLog={stub({ error: "db locked" })} />);
    expect(screen.getByRole("alert").textContent).toContain("db locked");
  });

  it("hides the Workday in review row when the log is off, even if the prop is passed", () => {
    render(
      <ActivityLogCard activityLog={stub()} workdayReview={workdayStub()} />,
    );
    expect(
      screen.queryByRole("switch", { name: /workday in review/i }),
    ).toBeNull();
  });

  it("hides the Workday in review row when the prop is absent, even while the log is on", () => {
    render(
      <ActivityLogCard
        activityLog={stub({
          settings: { enabled: true, retentionDays: 7, minSpanMinutes: 5 },
        })}
      />,
    );
    expect(
      screen.queryByRole("switch", { name: /workday in review/i }),
    ).toBeNull();
  });

  it("shows and toggles Workday in review once the log is on", () => {
    const workdayReview = workdayStub();
    render(
      <ActivityLogCard
        activityLog={stub({
          settings: { enabled: true, retentionDays: 7, minSpanMinutes: 5 },
        })}
        workdayReview={workdayReview}
      />,
    );
    const toggle = screen.getByRole("switch", {
      name: /workday in review/i,
    }) as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(workdayReview.setEnabled).toHaveBeenCalledWith(true);
  });
});
