import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";

const openUrl = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => openUrl(...args),
}));

import { UpdateBanner } from "./update-banner";

const UPDATE = {
  version: "0.2.0",
  currentVersion: "0.1.0",
  notes: "Nice things",
  releaseUrl: "https://github.com/drmowinckels/cairn/releases/tag/v0.2.0",
};

beforeEach(() => {
  openUrl.mockClear();
});

describe("UpdateBanner", () => {
  it("renders nothing when there's no update", () => {
    const { container } = render(
      <UpdateBanner update={null} onDismiss={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows the available version", () => {
    const { getByText } = render(
      <UpdateBanner update={UPDATE} onDismiss={vi.fn()} />,
    );
    expect(getByText("Cairn 0.2.0 is available")).toBeTruthy();
  });

  it("opens the release-notes URL", () => {
    const { getByText } = render(
      <UpdateBanner update={UPDATE} onDismiss={vi.fn()} />,
    );
    fireEvent.click(getByText("Release notes"));
    expect(openUrl).toHaveBeenCalledWith(UPDATE.releaseUrl);
  });

  it("falls back to window.open when the opener plugin rejects", async () => {
    openUrl.mockRejectedValueOnce(new Error("no opener"));
    const winOpen = vi
      .spyOn(window, "open")
      .mockReturnValue(null as unknown as Window);
    const { getByText } = render(
      <UpdateBanner update={UPDATE} onDismiss={vi.fn()} />,
    );
    fireEvent.click(getByText("Release notes"));
    await Promise.resolve();
    expect(winOpen).toHaveBeenCalledWith(
      UPDATE.releaseUrl,
      "_blank",
      "noopener",
    );
    winOpen.mockRestore();
  });

  it("calls onDismiss from the × button", () => {
    const onDismiss = vi.fn();
    const { getByLabelText } = render(
      <UpdateBanner update={UPDATE} onDismiss={onDismiss} />,
    );
    fireEvent.click(getByLabelText("Dismiss update notice"));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
