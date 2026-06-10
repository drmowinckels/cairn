import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Outside Tauri the cards' hooks no-op (empty lists); render is enough to
// assert the tab composes the three sections under one heading.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));

import { ExtensionsView } from "./extensions-view";

describe("ExtensionsView", () => {
  it("renders the Extensions heading and the Integrations section", () => {
    render(<ExtensionsView />);
    expect(screen.getByRole("heading", { name: /^extensions$/i })).toBeTruthy();
    // Integrations always renders (its rows aren't gated on backend data).
    expect(
      screen.getByRole("heading", { name: /^integrations$/i }),
    ).toBeTruthy();
  });
});
