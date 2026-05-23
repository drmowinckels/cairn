import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ErrorBoundary } from "./error-boundary";

function Boom({ throwIt }: { throwIt: boolean }) {
  if (throwIt) throw new Error("kaboom");
  return <div>ok</div>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
  it("renders children when nothing throws", () => {
    render(
      <ErrorBoundary area="Test">
        <Boom throwIt={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("ok")).toBeTruthy();
  });

  it("renders the fallback with the area name and error message when a child throws", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary area="PopoverArea">
        <Boom throwIt={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("PopoverArea crashed")).toBeTruthy();
    expect(screen.getByText(/kaboom/)).toBeTruthy();
    expect(errSpy).toHaveBeenCalled();
  });

  it("renders Try-again and Reload-window buttons in the fallback", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary area="X">
        <Boom throwIt={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /reload window/i })).toBeTruthy();
    expect(errSpy).toHaveBeenCalled();
  });

  it("clicking 'Reload window' calls window.location.reload()", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    const originalLocation = window.location;
    // Replace window.location with a writable object that captures reload().
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { ...originalLocation, reload },
    });
    try {
      render(
        <ErrorBoundary area="X">
          <Boom throwIt={true} />
        </ErrorBoundary>,
      );
      fireEvent.click(screen.getByRole("button", { name: /reload window/i }));
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        writable: true,
        value: originalLocation,
      });
      errSpy.mockRestore();
    }
  });

  it("clicking Try again clears the error and re-renders children", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <ErrorBoundary area="X">
        <Boom throwIt={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("X crashed")).toBeTruthy();

    // Swap the children first so they no longer throw, then click Try
    // again. If we clicked first, ErrorBoundary's reset would re-render
    // the still-throwing child and snap back to the fallback.
    rerender(
      <ErrorBoundary area="X">
        <Boom throwIt={false} />
      </ErrorBoundary>,
    );
    // Still on the fallback until reset is called.
    expect(screen.getByText("X crashed")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(screen.getByText("ok")).toBeTruthy();
    expect(errSpy).toHaveBeenCalled();
  });
});
