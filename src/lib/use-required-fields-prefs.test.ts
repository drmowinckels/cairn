import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRequiredFieldsPrefs } from "./use-required-fields-prefs";

const STORAGE_KEY = "cairn:required-fields:v1";

afterEach(() => window.localStorage.clear());

describe("useRequiredFieldsPrefs", () => {
  it("defaults to both prefs off", () => {
    const { result } = renderHook(() => useRequiredFieldsPrefs());
    expect(result.current.prefs).toEqual({
      requireProject: false,
      requireDescription: false,
    });
  });

  it("persists requireProject to localStorage", () => {
    const { result } = renderHook(() => useRequiredFieldsPrefs());
    act(() => result.current.setRequireProject(true));
    expect(result.current.prefs.requireProject).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toMatchObject(
      {
        requireProject: true,
      },
    );
  });

  it("persists requireDescription to localStorage", () => {
    const { result } = renderHook(() => useRequiredFieldsPrefs());
    act(() => result.current.setRequireDescription(true));
    expect(result.current.prefs.requireDescription).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toMatchObject(
      {
        requireDescription: true,
      },
    );
  });

  it("reads a persisted preference on mount", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ requireProject: true, requireDescription: true }),
    );
    const { result } = renderHook(() => useRequiredFieldsPrefs());
    expect(result.current.prefs).toEqual({
      requireProject: true,
      requireDescription: true,
    });
  });

  it("falls back to defaults on malformed storage", () => {
    window.localStorage.setItem(STORAGE_KEY, "not json");
    const { result } = renderHook(() => useRequiredFieldsPrefs());
    expect(result.current.prefs).toEqual({
      requireProject: false,
      requireDescription: false,
    });
  });

  it("coerces truthy-but-not-boolean storage values to false", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ requireProject: 1, requireDescription: "yes" }),
    );
    const { result } = renderHook(() => useRequiredFieldsPrefs());
    expect(result.current.prefs).toEqual({
      requireProject: false,
      requireDescription: false,
    });
  });

  it("keeps an earlier change when persistence fails (private mode)", () => {
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });
    const { result } = renderHook(() => useRequiredFieldsPrefs());
    act(() => result.current.setRequireProject(true));
    act(() => result.current.setRequireDescription(true));
    expect(result.current.prefs).toEqual({
      requireProject: true,
      requireDescription: true,
    });
    spy.mockRestore();
  });

  it("toggling requireProject off persists false", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ requireProject: true, requireDescription: false }),
    );
    const { result } = renderHook(() => useRequiredFieldsPrefs());
    act(() => result.current.setRequireProject(false));
    expect(result.current.prefs.requireProject).toBe(false);
  });
});
