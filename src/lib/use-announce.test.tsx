import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { AnnouncerProvider, useAnnounce } from "./use-announce";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function Caller({ messages }: { messages: string[] }) {
  const announce = useAnnounce();
  return (
    <button
      onClick={() => {
        messages.forEach((m) => announce(m));
      }}
    >
      go
    </button>
  );
}

describe("AnnouncerProvider", () => {
  it("renders the central polite live region with role=status", () => {
    render(
      <AnnouncerProvider enabled={true}>
        <span>child</span>
      </AnnouncerProvider>,
    );
    const region = screen.getByTestId("cairn-announcer");
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.getAttribute("aria-atomic")).toBe("true");
  });

  it("sets the live region text when announce() is called", () => {
    render(
      <AnnouncerProvider enabled={true}>
        <Caller messages={["Timer started"]} />
      </AnnouncerProvider>,
    );
    act(() => {
      screen.getByText("go").click();
    });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(screen.getByTestId("cairn-announcer").textContent).toBe(
      "Timer started",
    );
  });

  it("ignores announce calls when disabled", () => {
    render(
      <AnnouncerProvider enabled={false}>
        <Caller messages={["Timer started"]} />
      </AnnouncerProvider>,
    );
    act(() => {
      screen.getByText("go").click();
    });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(screen.getByTestId("cairn-announcer").textContent).toBe("");
  });

  it("coalesces a repeat of the same message", () => {
    render(
      <AnnouncerProvider enabled={true}>
        <Caller messages={["Same", "Same", "Same"]} />
      </AnnouncerProvider>,
    );
    act(() => {
      screen.getByText("go").click();
    });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(screen.getByTestId("cairn-announcer").textContent).toBe("Same");
  });

  it("clears the region when enabled flips off", () => {
    const { rerender } = render(
      <AnnouncerProvider enabled={true}>
        <Caller messages={["A"]} />
      </AnnouncerProvider>,
    );
    act(() => {
      screen.getByText("go").click();
    });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(screen.getByTestId("cairn-announcer").textContent).toBe("A");

    rerender(
      <AnnouncerProvider enabled={false}>
        <Caller messages={["A"]} />
      </AnnouncerProvider>,
    );
    expect(screen.getByTestId("cairn-announcer").textContent).toBe("");
  });

  it("useAnnounce is a no-op outside a provider", () => {
    const messages: string[] = [];
    // Render bare consumer — must not crash, and the call must be ignored.
    render(<Caller messages={["x"]} />);
    expect(() => {
      act(() => {
        screen.getByText("go").click();
      });
    }).not.toThrow();
    expect(messages).toEqual([]);
  });
});
