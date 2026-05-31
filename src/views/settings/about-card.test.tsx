import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const diagnostics = vi.fn();
vi.mock("../../lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("../../lib/ipc")>(
    "../../lib/ipc",
  );
  return { ...actual, diagnostics: (...a: unknown[]) => diagnostics(...a) };
});

import { AboutCard, formatDiagnostics } from "./about-card";

const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  diagnostics.mockReset();
  writeText.mockReset();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => vi.clearAllMocks());

const DIAG = {
  appVersion: "0.0.1",
  os: "macos",
  arch: "aarch64",
  projects: 5,
  clients: 3,
  rules: 0,
  exclusions: 2,
  entries: 9,
};

describe("formatDiagnostics", () => {
  it("formats a bundle with version, platform and counts", () => {
    const text = formatDiagnostics(DIAG);
    expect(text).toContain("Cairn v0.0.1");
    expect(text).toContain("macos/aarch64");
    expect(text).toContain("Projects: 5");
    expect(text).toContain("Entries: 9");
  });

  it("falls back for a dev build", () => {
    expect(formatDiagnostics(null)).toMatch(/dev build/i);
  });
});

describe("AboutCard", () => {
  it("shows the version from diagnostics and the maker", async () => {
    diagnostics.mockResolvedValue(DIAG);
    render(<AboutCard />);
    await waitFor(() => expect(screen.getByText(/v0\.0\.1/)).toBeTruthy());
    expect(screen.getByText(/Athanasia Monika Mowinckel/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /^github$/i })).toBeTruthy();
  });

  it("copies the diagnostics bundle to the clipboard with feedback", async () => {
    diagnostics.mockResolvedValue(DIAG);
    render(<AboutCard />);
    await waitFor(() => expect(screen.getByText(/v0\.0\.1/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /copy diagnostics/i }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining("Cairn v0.0.1"),
      ),
    );
    expect(await screen.findByText(/copied diagnostics/i)).toBeTruthy();
  });

  it("renders a dev version when diagnostics is unavailable", async () => {
    diagnostics.mockResolvedValue(null);
    const { container } = render(<AboutCard />);
    await waitFor(() =>
      expect(container.querySelector(".about-version")?.textContent).toMatch(
        /dev/i,
      ),
    );
  });
});
