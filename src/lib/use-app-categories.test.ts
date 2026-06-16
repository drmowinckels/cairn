import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const listAppCategoriesMock = vi.fn();

vi.mock("./ipc", () => ({
  listAppCategories: () => listAppCategoriesMock(),
}));

describe("useAppCategories (#189)", () => {
  beforeEach(() => {
    listAppCategoriesMock.mockReset();
    vi.resetModules();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  const table = [
    { category: "meeting", label: "Meeting apps", apps: ["Zoom"] },
  ];

  it("fetches the table once and returns it", async () => {
    listAppCategoriesMock.mockResolvedValue(table);
    const { useAppCategories } = await import("./use-app-categories");
    const { result } = renderHook(() => useAppCategories());
    await waitFor(() => expect(result.current).toEqual(table));
    expect(listAppCategoriesMock).toHaveBeenCalledTimes(1);
  });

  it("serves the cached table to a later mount without refetching", async () => {
    listAppCategoriesMock.mockResolvedValue(table);
    const { useAppCategories } = await import("./use-app-categories");
    const first = renderHook(() => useAppCategories());
    await waitFor(() => expect(first.result.current).toEqual(table));
    expect(listAppCategoriesMock).toHaveBeenCalledTimes(1);

    const second = renderHook(() => useAppCategories());
    expect(second.result.current).toEqual(table);
    // No second fetch — the module-level cache is reused.
    expect(listAppCategoriesMock).toHaveBeenCalledTimes(1);
  });

  it("stays empty and swallows a fetch failure", async () => {
    listAppCategoriesMock.mockRejectedValue(new Error("nope"));
    const { useAppCategories } = await import("./use-app-categories");
    const { result } = renderHook(() => useAppCategories());
    // Let the rejected promise settle; the hook keeps its empty default.
    await Promise.resolve();
    expect(result.current).toEqual([]);
  });
});
