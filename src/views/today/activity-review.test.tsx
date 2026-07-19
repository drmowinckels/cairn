import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const listMock = vi.fn();
const createMock = vi.fn();

vi.mock("../../lib/ipc", () => ({
  listActivityLog: (date: string) => listMock(date),
  createEntry: (input: unknown) => createMock(input),
}));

import { ActivityReview } from "./activity-review";

afterEach(() => {
  listMock.mockReset();
  createMock.mockReset();
});

const SPAN = {
  id: 1,
  startedAt: "2026-06-16T09:00:00+00:00",
  endedAt: "2026-06-16T09:30:00+00:00",
  appName: "Zoom",
  titleHint: "Standup",
  source: "window",
  hasEntry: false,
};

describe("ActivityReview (#190)", () => {
  it("renders the day's spans and the Time-by-app totals", async () => {
    listMock.mockResolvedValue([SPAN]);
    const { container } = render(
      <ActivityReview date="2026-06-16" onCreated={vi.fn()} />,
    );
    await waitFor(() =>
      expect(container.querySelector(".act-row")).toBeTruthy(),
    );
    expect(screen.getByText("Standup")).toBeTruthy();
    expect(container.querySelector(".act-dur")?.textContent).toBe("30m");
    const totals = screen.getByLabelText(/time by app/i);
    expect(totals.textContent).toMatch(/Zoom/);
    expect(totals.textContent).toMatch(/30m/);
    expect(listMock).toHaveBeenCalledWith("2026-06-16");
  });

  it("shows an empty state when nothing was recorded", async () => {
    listMock.mockResolvedValue([]);
    render(<ActivityReview date="2026-06-16" onCreated={vi.fn()} />);
    expect(await screen.findByText(/no activity recorded/i)).toBeTruthy();
  });

  it("Add turns a span into a time entry, refreshes, and leaves other spans untouched", async () => {
    const OTHER_SPAN = { ...SPAN, id: 2, appName: "Code", titleHint: null };
    listMock.mockResolvedValue([SPAN, OTHER_SPAN]);
    createMock.mockResolvedValue({ id: "e1" });
    const onCreated = vi.fn().mockResolvedValue(undefined);
    render(<ActivityReview date="2026-06-16" onCreated={onCreated} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: /add a time entry from zoom/i,
      }),
    );
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock.mock.calls[0][0]).toEqual({
      startedAt: SPAN.startedAt,
      endedAt: SPAN.endedAt,
      description: "Standup",
      source: "activity_log",
      activityRowId: SPAN.id,
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    // The span's button flips to "Added" + disabled, so a second click can't
    // create a duplicate entry.
    const btn = await screen.findByRole("button", { name: /already added/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(btn);
    expect(createMock).toHaveBeenCalledTimes(1);
    // The other span is untouched — only the added row's state flips.
    expect(
      screen.getByRole("button", { name: /add a time entry from code/i }),
    ).toBeTruthy();
  });

  it("a span already linked to an entry (hasEntry) renders Added on load, not after a click", async () => {
    listMock.mockResolvedValue([{ ...SPAN, hasEntry: true }]);
    render(<ActivityReview date="2026-06-16" onCreated={vi.fn()} />);
    const btn = await screen.findByRole("button", { name: /already added/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("renders whole-minute Time-by-app totals for a non-minute-aligned span", async () => {
    // 145s → must show 2m, not 2.4166…m (fmtHm needs integer minutes).
    listMock.mockResolvedValue([
      {
        ...SPAN,
        startedAt: "2026-06-16T09:00:00+00:00",
        endedAt: "2026-06-16T09:02:25+00:00",
      },
    ]);
    render(<ActivityReview date="2026-06-16" onCreated={vi.fn()} />);
    const totals = await screen.findByLabelText(/time by app/i);
    expect(totals.textContent).toMatch(/2m/);
    expect(totals.textContent).not.toMatch(/\./);
  });

  it("surfaces a create error", async () => {
    listMock.mockResolvedValue([SPAN]);
    createMock.mockRejectedValue(new Error("db locked"));
    render(<ActivityReview date="2026-06-16" onCreated={vi.fn()} />);
    fireEvent.click(
      await screen.findByRole("button", { name: /add a time entry/i }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("db locked"),
    );
  });

  it("surfaces a load error", async () => {
    listMock.mockRejectedValue(new Error("boom"));
    render(<ActivityReview date="2026-06-16" onCreated={vi.fn()} />);
    expect((await screen.findByRole("alert")).textContent).toContain("boom");
  });

  it("a span with no title hint shows no hint and creates with an empty description", async () => {
    listMock.mockResolvedValue([{ ...SPAN, titleHint: null }]);
    createMock.mockResolvedValue({ id: "e1" });
    const { container } = render(
      <ActivityReview date="2026-06-16" onCreated={vi.fn()} />,
    );
    await waitFor(() =>
      expect(container.querySelector(".act-row")).toBeTruthy(),
    );
    expect(container.querySelector(".act-hint")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /add a time entry/i }));
    await waitFor(() => expect(createMock).toHaveBeenCalled());
    expect(createMock.mock.calls[0][0].description).toBe("");
  });

  it("ignores a load that resolves/rejects after unmount", async () => {
    let resolve!: (v: unknown) => void;
    listMock.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const a = render(<ActivityReview date="2026-06-16" onCreated={vi.fn()} />);
    a.unmount();
    resolve([SPAN]); // late resolve — the cancelled guard skips setState
    await Promise.resolve();

    let reject!: (e: Error) => void;
    listMock.mockReturnValueOnce(
      new Promise((_r, rej) => {
        reject = rej;
      }),
    );
    const b = render(<ActivityReview date="2026-06-16" onCreated={vi.fn()} />);
    b.unmount();
    reject(new Error("late")); // late reject — guard skips setError
    await Promise.resolve();
    // No act() warning / crash → the guards held.
  });
});
