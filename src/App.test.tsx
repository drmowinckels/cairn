import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("./views/popover", () => ({
  Popover: () => <div data-testid="popover" />,
}));
vi.mock("./views/idle/idle-window", () => ({
  IdleWindow: () => <div data-testid="idle" />,
}));
vi.mock("./views/about/about-window", () => ({
  AboutWindow: () => <div data-testid="about" />,
}));

import App from "./App";

function setWin(win: string | null) {
  window.history.replaceState({}, "", win ? `/?win=${win}` : "/");
}

describe("App window routing", () => {
  afterEach(() => {
    setWin(null);
    vi.restoreAllMocks();
  });

  it("renders the Popover by default", () => {
    setWin(null);
    expect(render(<App />).getByTestId("popover")).toBeTruthy();
  });

  it("renders the Idle window under ?win=idle", () => {
    setWin("idle");
    expect(render(<App />).getByTestId("idle")).toBeTruthy();
  });

  it("renders the About window under ?win=about", () => {
    setWin("about");
    expect(render(<App />).getByTestId("about")).toBeTruthy();
  });

  it("falls back to the Popover when the query can't be parsed", () => {
    const orig = globalThis.URLSearchParams;
    globalThis.URLSearchParams = class {
      constructor() {
        throw new Error("boom");
      }
    } as unknown as typeof URLSearchParams;
    try {
      expect(render(<App />).getByTestId("popover")).toBeTruthy();
    } finally {
      globalThis.URLSearchParams = orig;
    }
  });
});
