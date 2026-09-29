import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  DateField,
  DateTimeField,
  TimeField,
  joinLocal,
  splitLocal,
} from "./datetime-fields";
import { setLocaleForTest } from "./locale";
import { resetDateTimeFormatPrefsForTest } from "./use-datetime-format";

beforeEach(() => {
  setLocaleForTest("en-US");
  resetDateTimeFormatPrefsForTest({ time: "24h", date: "dmy" });
});

describe("TimeField", () => {
  it("renders the stored 24-hour value in the chosen format", () => {
    const { rerender } = render(
      <TimeField label="Start" value="14:05" onChange={vi.fn()} />,
    );
    expect((screen.getByLabelText("Start") as HTMLInputElement).value).toBe(
      "14:05",
    );

    resetDateTimeFormatPrefsForTest({ time: "12h", date: "dmy" });
    rerender(<TimeField label="Start" value="14:05" onChange={vi.fn()} />);
    expect((screen.getByLabelText("Start") as HTMLInputElement).value).toMatch(
      /2:05\s*PM/i,
    );
  });

  it("stores 24-hour HH:MM whatever the display format", () => {
    // The preference must change what's shown, never what's saved — otherwise
    // switching it would rewrite entries.
    resetDateTimeFormatPrefsForTest({ time: "12h", date: "dmy" });
    const onChange = vi.fn();
    render(<TimeField label="Start" value="" onChange={onChange} />);
    const input = screen.getByLabelText("Start");
    fireEvent.change(input, { target: { value: "2:05 pm" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith("14:05");
  });

  it("accepts loose input and normalises it on blur", () => {
    const onChange = vi.fn();
    render(<TimeField label="Start" value="" onChange={onChange} />);
    const input = screen.getByLabelText("Start");
    fireEvent.change(input, { target: { value: "1405" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith("14:05");
  });

  it("commits on Enter as well as blur", () => {
    const onChange = vi.fn();
    render(<TimeField label="Start" value="" onChange={onChange} />);
    const input = screen.getByLabelText("Start");
    fireEvent.change(input, { target: { value: "9:30" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("09:30");
  });

  it("marks unparseable input invalid with a real message, and keeps the text", () => {
    const onChange = vi.fn();
    render(<TimeField label="Start" value="" onChange={onChange} />);
    const input = screen.getByLabelText("Start");
    fireEvent.change(input, { target: { value: "lunchtime" } });
    fireEvent.blur(input);

    expect(onChange).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toMatch(/hh:mm/i);
    // The keystrokes survive so the user can fix them rather than retype.
    expect((input as HTMLInputElement).value).toBe("lunchtime");
  });

  it("clears the error as soon as the user edits again", () => {
    render(<TimeField label="Start" value="" onChange={vi.fn()} />);
    const input = screen.getByLabelText("Start");
    fireEvent.change(input, { target: { value: "nope" } });
    fireEvent.blur(input);
    expect(input.getAttribute("aria-invalid")).toBe("true");

    fireEvent.change(input, { target: { value: "9:00" } });
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("steps by a minute with the arrow keys", () => {
    const onChange = vi.fn();
    render(<TimeField label="Start" value="09:00" onChange={onChange} />);
    const input = screen.getByLabelText("Start");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith("09:01");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(onChange).toHaveBeenLastCalledWith("08:59");
  });

  it("wraps rather than producing an impossible time", () => {
    const onChange = vi.fn();
    render(<TimeField label="Start" value="23:59" onChange={onChange} />);
    fireEvent.keyDown(screen.getByLabelText("Start"), { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith("00:00");
  });

  it("announces its expected format through aria-describedby", () => {
    render(<TimeField label="Start" value="" onChange={vi.fn()} />);
    const input = screen.getByLabelText("Start");
    const describedBy = input.getAttribute("aria-describedby")!;
    const hint = describedBy
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent)
      .join(" ");
    expect(hint).toMatch(/hh:mm/i);
  });

  it("lets an optional field be emptied, but not a required one", () => {
    const optional = vi.fn();
    const { unmount } = render(
      <TimeField label="End" value="09:00" onChange={optional} />,
    );
    fireEvent.change(screen.getByLabelText("End"), { target: { value: "" } });
    fireEvent.blur(screen.getByLabelText("End"));
    expect(optional).toHaveBeenCalledWith("");
    unmount();

    const required = vi.fn();
    render(
      <TimeField label="Start" value="09:00" onChange={required} required />,
    );
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "" } });
    fireEvent.blur(screen.getByLabelText("Start"));
    expect(required).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Start").getAttribute("aria-invalid")).toBe(
      "true",
    );
  });
});

describe("DateField", () => {
  it("renders the stored ISO value in the chosen order", () => {
    const { rerender } = render(
      <DateField label="Day" value="2026-12-25" onChange={vi.fn()} />,
    );
    expect((screen.getByLabelText("Day") as HTMLInputElement).value).toBe(
      "25/12/2026",
    );

    resetDateTimeFormatPrefsForTest({ time: "24h", date: "mdy" });
    rerender(<DateField label="Day" value="2026-12-25" onChange={vi.fn()} />);
    expect((screen.getByLabelText("Day") as HTMLInputElement).value).toBe(
      "12/25/2026",
    );
  });

  it("stores ISO whatever the typed order", () => {
    resetDateTimeFormatPrefsForTest({ time: "24h", date: "mdy" });
    const onChange = vi.fn();
    render(<DateField label="Day" value="" onChange={onChange} />);
    const input = screen.getByLabelText("Day");
    fireEvent.change(input, { target: { value: "12/25/2026" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith("2026-12-25");
  });

  it("reads the same digits differently under a different order", () => {
    // The whole reason the preference exists: 03/04 is not one date.
    const dmy = vi.fn();
    const { unmount } = render(
      <DateField label="Day" value="" onChange={dmy} />,
    );
    fireEvent.change(screen.getByLabelText("Day"), {
      target: { value: "03/04/2026" },
    });
    fireEvent.blur(screen.getByLabelText("Day"));
    expect(dmy).toHaveBeenCalledWith("2026-04-03");
    unmount();

    resetDateTimeFormatPrefsForTest({ time: "24h", date: "mdy" });
    const mdy = vi.fn();
    render(<DateField label="Day" value="" onChange={mdy} />);
    fireEvent.change(screen.getByLabelText("Day"), {
      target: { value: "03/04/2026" },
    });
    fireEvent.blur(screen.getByLabelText("Day"));
    expect(mdy).toHaveBeenCalledWith("2026-03-04");
  });

  it("rejects a date that doesn't exist", () => {
    const onChange = vi.fn();
    render(<DateField label="Day" value="" onChange={onChange} />);
    const input = screen.getByLabelText("Day");
    fireEvent.change(input, { target: { value: "31/02/2026" } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("steps by a day with the arrow keys, crossing a month boundary", () => {
    const onChange = vi.fn();
    render(<DateField label="Day" value="2026-03-01" onChange={onChange} />);
    fireEvent.keyDown(screen.getByLabelText("Day"), { key: "ArrowDown" });
    expect(onChange).toHaveBeenLastCalledWith("2026-02-28");
  });

  it("announces its expected order through aria-describedby", () => {
    render(<DateField label="Day" value="" onChange={vi.fn()} />);
    const input = screen.getByLabelText("Day");
    const text = input
      .getAttribute("aria-describedby")!
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent)
      .join(" ");
    expect(text).toMatch(/dd\/mm\/yyyy/i);
  });
});

describe("DateTimeField", () => {
  it("splits into separately-labelled date and time controls", () => {
    render(
      <DateTimeField
        label="Start"
        value="2026-12-25T14:05"
        onChange={vi.fn()}
      />,
    );
    expect(
      (screen.getByLabelText("Start date") as HTMLInputElement).value,
    ).toBe("25/12/2026");
    expect(
      (screen.getByLabelText("Start time") as HTMLInputElement).value,
    ).toBe("14:05");
  });

  it("keeps the other half when one half changes", () => {
    const onChange = vi.fn();
    render(
      <DateTimeField
        label="Start"
        value="2026-12-25T14:05"
        onChange={onChange}
      />,
    );
    const time = screen.getByLabelText("Start time");
    fireEvent.change(time, { target: { value: "09:30" } });
    fireEvent.blur(time);
    expect(onChange).toHaveBeenCalledWith("2026-12-25T09:30");
  });

  it("never reports a half-filled timestamp", () => {
    // A partial string would look like a real value to a caller and fail
    // somewhere less obvious; callers already treat "" as "not set".
    const onChange = vi.fn();
    render(<DateTimeField label="Start" value="" onChange={onChange} />);
    const time = screen.getByLabelText("Start time");
    fireEvent.change(time, { target: { value: "09:30" } });
    fireEvent.blur(time);
    expect(onChange).not.toHaveBeenCalledWith(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
  });

  it("holds a half-entered value so it can be filled in either order", () => {
    // Starting from empty, the date has to survive until the time is typed.
    // Deriving both halves from `value` alone discarded it on round-trip,
    // making an empty Start impossible to fill date-first.
    const onChange = vi.fn();
    const { rerender } = render(
      <DateTimeField label="Start" value="" onChange={onChange} />,
    );

    const date = screen.getByLabelText("Start date");
    fireEvent.change(date, { target: { value: "2026-12-25" } });
    fireEvent.blur(date);
    // Nothing reported yet — the pair is incomplete.
    expect(onChange).not.toHaveBeenCalled();
    // …but the typed date is still on screen.
    expect((date as HTMLInputElement).value).toBe("25/12/2026");

    const time = screen.getByLabelText("Start time");
    fireEvent.change(time, { target: { value: "09:30" } });
    fireEvent.blur(time);
    expect(onChange).toHaveBeenCalledWith("2026-12-25T09:30");

    // And the completed value round-trips without disturbing either half.
    rerender(
      <DateTimeField
        label="Start"
        value="2026-12-25T09:30"
        onChange={onChange}
      />,
    );
    expect(
      (screen.getByLabelText("Start date") as HTMLInputElement).value,
    ).toBe("25/12/2026");
    expect(
      (screen.getByLabelText("Start time") as HTMLInputElement).value,
    ).toBe("09:30");
  });

  it("reports empty once both halves are cleared", () => {
    const onChange = vi.fn();
    render(
      <DateTimeField
        label="End"
        value="2026-12-25T09:30"
        onChange={onChange}
      />,
    );
    const date = screen.getByLabelText("End date");
    fireEvent.change(date, { target: { value: "" } });
    fireEvent.blur(date);
    const time = screen.getByLabelText("End time");
    fireEvent.change(time, { target: { value: "" } });
    fireEvent.blur(time);
    expect(onChange).toHaveBeenLastCalledWith("");
  });
});

describe("splitLocal / joinLocal", () => {
  it("round-trip", () => {
    expect(splitLocal("2026-12-25T14:05")).toEqual(["2026-12-25", "14:05"]);
    expect(joinLocal("2026-12-25", "14:05")).toBe("2026-12-25T14:05");
  });

  it("tolerates seconds on the way in", () => {
    expect(splitLocal("2026-12-25T14:05:30")).toEqual(["2026-12-25", "14:05"]);
  });

  it("treats anything malformed as empty", () => {
    for (const junk of ["", "2026-12-25", "nonsense"]) {
      expect(splitLocal(junk)).toEqual(["", ""]);
    }
    expect(joinLocal("2026-12-25", "")).toBe("");
    expect(joinLocal("", "14:05")).toBe("");
  });
});

describe("edge cases the UI can still reach", () => {
  it("renders nothing for a stored value outside the clock range", () => {
    // `value` is a wire string; a malformed one must not render "99:99".
    render(<TimeField label="Start" value="99:99" onChange={vi.fn()} />);
    expect((screen.getByLabelText("Start") as HTMLInputElement).value).toBe("");
  });

  it("renders nothing for a stored date that doesn't exist", () => {
    // `new Date(2026, 1, 31)` is 3 March; showing that would be a different
    // day than the one stored.
    render(<DateField label="Day" value="2026-02-31" onChange={vi.fn()} />);
    expect((screen.getByLabelText("Day") as HTMLInputElement).value).toBe("");
  });

  it("steps a time field from midnight when there's nothing to step from", () => {
    const onChange = vi.fn();
    render(<TimeField label="Start" value="" onChange={onChange} />);
    fireEvent.keyDown(screen.getByLabelText("Start"), { key: "ArrowUp" });
    expect(onChange).toHaveBeenCalledWith("00:01");
  });

  it("steps a time field from the stored value when the draft is unparseable", () => {
    const onChange = vi.fn();
    render(<TimeField label="Start" value="09:00" onChange={onChange} />);
    const input = screen.getByLabelText("Start");
    fireEvent.change(input, { target: { value: "nonsense" } });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(onChange).toHaveBeenCalledWith("09:01");
  });

  it("does nothing when stepping a date field with no date at all", () => {
    const onChange = vi.fn();
    render(<DateField label="Day" value="" onChange={onChange} />);
    fireEvent.keyDown(screen.getByLabelText("Day"), { key: "ArrowDown" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("steps a date field from the stored value when the draft is unparseable", () => {
    const onChange = vi.fn();
    render(<DateField label="Day" value="2026-03-01" onChange={onChange} />);
    const input = screen.getByLabelText("Day");
    fireEvent.change(input, { target: { value: "gibberish" } });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(onChange).toHaveBeenCalledWith("2026-03-02");
  });

  it("ignores keys that aren't Enter or an arrow", () => {
    const onChange = vi.fn();
    render(<TimeField label="Start" value="09:00" onChange={onChange} />);
    fireEvent.keyDown(screen.getByLabelText("Start"), { key: "a" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("appends a caller's describedBy alongside the format hint", () => {
    render(
      <>
        <TimeField
          label="Start"
          value=""
          onChange={vi.fn()}
          describedBy="outside-err"
        />
        <span id="outside-err">Start can&apos;t be in the future.</span>
      </>,
    );
    const described = screen
      .getByLabelText("Start")
      .getAttribute("aria-describedby")!;
    expect(described.split(" ")).toContain("outside-err");
    // …and the format hint is still in there.
    const text = described
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent)
      .join(" ");
    expect(text).toMatch(/hh:mm/i);
    expect(text).toMatch(/future/i);
  });

  it("honours a caller-supplied id", () => {
    render(
      <TimeField label="Start" value="" onChange={vi.fn()} id="my-start" />,
    );
    expect(screen.getByLabelText("Start").id).toBe("my-start");
  });

  it("can be disabled", () => {
    render(
      <DateField label="Day" value="2026-12-25" onChange={vi.fn()} disabled />,
    );
    expect((screen.getByLabelText("Day") as HTMLInputElement).disabled).toBe(
      true,
    );
  });

  it("resets both halves when the value is cleared from outside", () => {
    const { rerender } = render(
      <DateTimeField
        label="Start"
        value="2026-12-25T14:05"
        onChange={vi.fn()}
      />,
    );
    rerender(<DateTimeField label="Start" value="" onChange={vi.fn()} />);
    expect(
      (screen.getByLabelText("Start date") as HTMLInputElement).value,
    ).toBe("");
    expect(
      (screen.getByLabelText("Start time") as HTMLInputElement).value,
    ).toBe("");
  });

  it("re-renders its value when the format preference changes", () => {
    const { rerender } = render(
      <DateTimeField
        label="Start"
        value="2026-12-25T14:05"
        onChange={vi.fn()}
      />,
    );
    resetDateTimeFormatPrefsForTest({ time: "12h", date: "mdy" });
    rerender(
      <DateTimeField
        label="Start"
        value="2026-12-25T14:05"
        onChange={vi.fn()}
      />,
    );
    expect(
      (screen.getByLabelText("Start date") as HTMLInputElement).value,
    ).toBe("12/25/2026");
    expect(
      (screen.getByLabelText("Start time") as HTMLInputElement).value,
    ).toMatch(/2:05\s*PM/i);
  });
});

describe("DateField parity with TimeField", () => {
  it("lets an optional field be emptied, but not a required one", () => {
    const optional = vi.fn();
    const { unmount } = render(
      <DateField label="To" value="2026-12-25" onChange={optional} />,
    );
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "" } });
    fireEvent.blur(screen.getByLabelText("To"));
    expect(optional).toHaveBeenCalledWith("");
    unmount();

    const required = vi.fn();
    render(
      <DateField
        label="From"
        value="2026-12-25"
        onChange={required}
        required
      />,
    );
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "" } });
    fireEvent.blur(screen.getByLabelText("From"));
    expect(required).not.toHaveBeenCalled();
    expect(screen.getByLabelText("From").getAttribute("aria-invalid")).toBe(
      "true",
    );
  });

  it("clears the error as soon as the user edits again", () => {
    render(<DateField label="Day" value="" onChange={vi.fn()} />);
    const input = screen.getByLabelText("Day");
    fireEvent.change(input, { target: { value: "nope" } });
    fireEvent.blur(input);
    expect(input.getAttribute("aria-invalid")).toBe("true");

    fireEvent.change(input, { target: { value: "25/12/2026" } });
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });
});
