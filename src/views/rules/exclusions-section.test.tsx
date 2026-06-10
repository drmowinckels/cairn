import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const listExclusions = vi.fn();
const saveExclusion = vi.fn();
const deleteExclusion = vi.fn();

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    inTauri: true,
    listExclusions: (...a: unknown[]) => listExclusions(...a),
    saveExclusion: (...a: unknown[]) => saveExclusion(...a),
    deleteExclusion: (...a: unknown[]) => deleteExclusion(...a),
  };
});

import { ExclusionsSection } from "./exclusions-section";

beforeEach(() => {
  listExclusions.mockReset().mockResolvedValue([]);
  saveExclusion.mockReset().mockResolvedValue({
    id: "n",
    kind: "domain",
    value: "x",
  });
  deleteExclusion.mockReset().mockResolvedValue(undefined);
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

  it("lists existing exclusions and removes one on the × button", async () => {
    listExclusions.mockResolvedValue([
      { id: "e1", kind: "domain", value: "mail.proton.me" },
    ]);
    render(<ExclusionsSection />);

    const code = await screen.findByText("mail.proton.me");
    expect(code).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /remove mail\.proton\.me/i }),
    );
    expect(deleteExclusion).toHaveBeenCalledWith("e1");
  });

  it("adding an exclusion infers the kind and calls save", async () => {
    render(<ExclusionsSection />);
    const input = screen.getByLabelText(/add exclusion/i);
    fireEvent.change(input, { target: { value: "mail.proton.me" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(saveExclusion).toHaveBeenCalledWith("domain", "mail.proton.me"),
    );
  });

  it("ignores a blank submit and a non-Enter keypress", async () => {
    render(<ExclusionsSection />);
    const input = screen.getByLabelText(/add exclusion/i);
    // Whitespace-only → trimmed to empty → no save.
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    // A non-Enter key never submits.
    fireEvent.change(input, { target: { value: "github.com" } });
    fireEvent.keyDown(input, { key: "a" });
    await Promise.resolve();
    expect(saveExclusion).not.toHaveBeenCalled();
  });

  it("surfaces an error from the exclusions hook", async () => {
    listExclusions.mockRejectedValue(new Error("db locked"));
    render(<ExclusionsSection />);
    expect(await screen.findByText(/db locked/i)).toBeTruthy();
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
