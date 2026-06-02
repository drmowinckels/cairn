import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";

const getGitDiscoveryRoots = vi.fn();
const setGitDiscoveryRoots = vi.fn();
vi.mock("../../lib/ipc", () => ({
  getGitDiscoveryRoots: () => getGitDiscoveryRoots(),
  setGitDiscoveryRoots: (roots: string[]) => setGitDiscoveryRoots(roots),
}));

import { GitRootsManager } from "./git-roots-manager";

beforeEach(() => {
  getGitDiscoveryRoots.mockReset().mockResolvedValue(["~/code"]);
  setGitDiscoveryRoots.mockReset().mockResolvedValue({
    discoveryRoots: ["~/code"],
    watchedCount: 1,
  });
});

describe("GitRootsManager modal a11y", () => {
  it("moves focus into the dialog on open", async () => {
    const { getByRole } = render(
      <GitRootsManager onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        getByRole("dialog", { name: /git discovery roots/i }),
      ),
    );
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    const { getByRole } = render(
      <GitRootsManager onClose={onClose} onSaved={vi.fn()} />,
    );
    fireEvent.keyDown(getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes when the backdrop is pressed", () => {
    const onClose = vi.fn();
    const { container } = render(
      <GitRootsManager onClose={onClose} onSaved={vi.fn()} />,
    );
    const scrim = container.querySelector(".modal-scrim") as HTMLElement;
    fireEvent.mouseDown(scrim);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
