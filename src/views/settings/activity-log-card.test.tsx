import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ActivityLogCard } from "./activity-log-card";
import type { UseActivityLog } from "../../lib/use-activity-log";

function stub(over: Partial<UseActivityLog> = {}): UseActivityLog {
  return {
    settings: { enabled: false, retentionDays: 7 },
    error: null,
    setEnabled: vi.fn().mockResolvedValue(undefined),
    setRetentionDays: vi.fn().mockResolvedValue(undefined),
    deleteAll: vi.fn().mockResolvedValue(undefined),
    exportToFile: vi.fn().mockResolvedValue(undefined),
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
    const al = stub({ settings: { enabled: true, retentionDays: 7 } });
    render(<ActivityLogCard activityLog={al} />);
    fireEvent.click(screen.getByRole("switch", { name: /save activity log/i }));
    expect(al.setEnabled).toHaveBeenCalledWith(false);
    expect(screen.queryByTestId("activity-confirm")).toBeNull();
  });

  it("shows the retention dropdown when on and writes a change", () => {
    const al = stub({ settings: { enabled: true, retentionDays: 7 } });
    render(<ActivityLogCard activityLog={al} />);
    const sel = screen.getByLabelText(
      /activity log retention/i,
    ) as HTMLSelectElement;
    expect(sel.value).toBe("7");
    fireEvent.change(sel, { target: { value: "0" } });
    expect(al.setRetentionDays).toHaveBeenCalledWith(0);
  });

  it("Delete activity log now calls deleteAll", () => {
    const al = stub({ settings: { enabled: true, retentionDays: 7 } });
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

    const on = stub({ settings: { enabled: true, retentionDays: 7 } });
    rerender(<ActivityLogCard activityLog={on} />);
    fireEvent.click(screen.getByRole("button", { name: /export csv/i }));
    expect(on.exportToFile).toHaveBeenCalledTimes(1);
  });

  it("renders an error banner when the hook reports one", () => {
    render(<ActivityLogCard activityLog={stub({ error: "db locked" })} />);
    expect(screen.getByRole("alert").textContent).toContain("db locked");
  });
});
