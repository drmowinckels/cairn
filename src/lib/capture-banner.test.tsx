import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CaptureBanner } from "./capture-banner";

describe("CaptureBanner", () => {
  it("renders nothing when capture is inactive", () => {
    const { container } = render(
      <CaptureBanner
        status={{ active: false, path: null, bytesWritten: 0 }}
        onStop={() => undefined}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows the persistent banner when capture is active", () => {
    render(
      <CaptureBanner
        status={{
          active: true,
          path: "/tmp/cairn/debug-signals.ndjson",
          bytesWritten: 256,
        }}
        onStop={() => undefined}
      />,
    );
    const banner = screen.getByTestId("capture-banner");
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain("Capturing raw signals");
    expect(banner.getAttribute("aria-live")).toBe("polite");
    expect(banner.getAttribute("role")).toBe("status");
  });

  it("calls onStop when the stop button is clicked", () => {
    const onStop = vi.fn();
    render(
      <CaptureBanner
        status={{ active: true, path: "/tmp/x.ndjson", bytesWritten: 0 }}
        onStop={onStop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /stop/i }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("flips back to nothing when status drops to inactive (banner tied to capture state)", () => {
    const { container, rerender } = render(
      <CaptureBanner
        status={{ active: true, path: "/tmp/x.ndjson", bytesWritten: 0 }}
        onStop={() => undefined}
      />,
    );
    expect(screen.queryByTestId("capture-banner")).not.toBeNull();
    rerender(
      <CaptureBanner
        status={{ active: false, path: null, bytesWritten: 0 }}
        onStop={() => undefined}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
