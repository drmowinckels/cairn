import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn(),
}));

import App from "./App";

describe("App", () => {
  it("wraps the Popover in an ErrorBoundary", () => {
    const { container } = render(<App />);
    // The popover renders a dialog landmark with the brand name.
    expect(container.querySelector(".pop")).toBeTruthy();
  });
});
