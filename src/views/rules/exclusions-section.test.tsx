import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { ExclusionsSection } from "./exclusions-section";

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("ExclusionsSection", () => {
  it("renders the 'Never track these' heading", () => {
    render(<ExclusionsSection />);
    expect(
      screen.getByRole("heading", { name: /never track these/i }),
    ).toBeTruthy();
  });

  it("adding an exclusion infers the kind and calls save_exclusion", () => {
    invokeMock.mockResolvedValue({
      id: "n",
      kind: "domain",
      value: "mail.proton.me",
    });
    render(<ExclusionsSection />);
    const input = screen.getByLabelText(/add exclusion/i);
    fireEvent.change(input, { target: { value: "mail.proton.me" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(invokeMock).toHaveBeenCalledWith("save_exclusion", {
      input: { kind: "domain", value: "mail.proton.me" },
    });
  });

  it("the incognito pause toggle persists its state to localStorage", () => {
    window.localStorage.removeItem("cairn:pause-on-incognito:v1");
    render(<ExclusionsSection />);
    const cb = screen.getByRole("checkbox", { name: /private\/incognito/i });
    expect((cb as HTMLInputElement).checked).toBe(true);
    fireEvent.click(cb);
    expect(window.localStorage.getItem("cairn:pause-on-incognito:v1")).toBe(
      "false",
    );
  });
});
