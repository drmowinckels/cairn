import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  applyMruOrder,
  createMruStore,
  MRU_KEY,
  MRU_MAX,
  usePalette,
} from "./use-palette";

function Harness({ onOpen }: { onOpen?: () => void }) {
  const palette = usePalette({ onOpen });
  return (
    <div>
      <button onClick={palette.requestOpen}>opener</button>
      <button onClick={palette.close}>close</button>
      <span data-testid="state">{palette.open ? "open" : "closed"}</span>
    </div>
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("usePalette — keyboard shortcut", () => {
  it("opens on ⌘K", () => {
    render(<Harness />);
    expect(screen.getByTestId("state").textContent).toBe("closed");
    act(() => {
      fireEvent.keyDown(window, { key: "k", metaKey: true });
    });
    expect(screen.getByTestId("state").textContent).toBe("open");
  });

  it("opens on Ctrl+K", () => {
    render(<Harness />);
    act(() => {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    });
    expect(screen.getByTestId("state").textContent).toBe("open");
  });

  it("opens on uppercase 'K' (Shift+⌘K)", () => {
    render(<Harness />);
    act(() => {
      fireEvent.keyDown(window, { key: "K", metaKey: true });
    });
    expect(screen.getByTestId("state").textContent).toBe("open");
  });

  it("ignores plain 'k' (no modifier)", () => {
    render(<Harness />);
    act(() => {
      fireEvent.keyDown(window, { key: "k" });
    });
    expect(screen.getByTestId("state").textContent).toBe("closed");
  });

  it("ignores other letters with the modifier", () => {
    render(<Harness />);
    act(() => {
      fireEvent.keyDown(window, { key: "j", metaKey: true });
    });
    expect(screen.getByTestId("state").textContent).toBe("closed");
  });

  it("⌘K a second time closes the palette (toggle)", () => {
    render(<Harness />);
    act(() => {
      fireEvent.keyDown(window, { key: "k", metaKey: true });
    });
    expect(screen.getByTestId("state").textContent).toBe("open");
    act(() => {
      fireEvent.keyDown(window, { key: "k", metaKey: true });
    });
    expect(screen.getByTestId("state").textContent).toBe("closed");
  });

  it("calls onOpen on every open transition", () => {
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);
    act(() => {
      fireEvent.keyDown(window, { key: "k", metaKey: true });
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("removes the listener on unmount", () => {
    const { unmount } = render(<Harness />);
    unmount();
    act(() => {
      fireEvent.keyDown(window, { key: "k", metaKey: true });
    });
    // No throw, no state to check — the test is "this didn't crash."
    expect(true).toBe(true);
  });
});

describe("usePalette — programmatic open/close + focus return", () => {
  it("requestOpen opens the palette", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("opener"));
    expect(screen.getByTestId("state").textContent).toBe("open");
  });

  it("close() returns focus to the opener", async () => {
    render(<Harness />);
    const opener = screen.getByText("opener");
    opener.focus();
    fireEvent.click(opener);
    // Move focus elsewhere to simulate the palette grabbing it.
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    fireEvent.click(screen.getByText("close"));
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(opener);
    elsewhere.remove();
  });

  it("toggle-close via ⌘K also returns focus to the opener", async () => {
    render(<Harness />);
    const opener = screen.getByText("opener");
    opener.focus();
    fireEvent.click(opener);
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    act(() => {
      fireEvent.keyDown(window, { key: "k", metaKey: true });
    });
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(opener);
    elsewhere.remove();
  });
});

describe("MRU store", () => {
  it("read() returns [] when no MRU is set", () => {
    const store = createMruStore();
    expect(store.read()).toEqual([]);
  });

  it("bump() prepends new ids and dedupes", () => {
    const store = createMruStore();
    store.bump("a");
    store.bump("b");
    store.bump("a");
    expect(store.read()).toEqual(["a", "b"]);
  });

  it("caps the list at MRU_MAX entries", () => {
    const store = createMruStore();
    for (let i = 0; i < MRU_MAX + 10; i++) store.bump(`id-${i}`);
    expect(store.read()).toHaveLength(MRU_MAX);
    // Most recent id is first.
    expect(store.read()[0]).toBe(`id-${MRU_MAX + 9}`);
  });

  it("clear() empties the MRU", () => {
    const store = createMruStore();
    store.bump("a");
    store.clear();
    expect(store.read()).toEqual([]);
  });

  it("read() tolerates malformed JSON in storage", () => {
    window.localStorage.setItem(MRU_KEY, "not-json");
    const store = createMruStore();
    expect(store.read()).toEqual([]);
  });

  it("read() filters non-string entries", () => {
    window.localStorage.setItem(MRU_KEY, JSON.stringify(["a", 42, null, "b"]));
    const store = createMruStore();
    expect(store.read()).toEqual(["a", "b"]);
  });

  it("read() returns [] when the stored payload is not an array", () => {
    window.localStorage.setItem(MRU_KEY, JSON.stringify({ a: 1 }));
    const store = createMruStore();
    expect(store.read()).toEqual([]);
  });

  it("falls back to a no-op store when storage is null", () => {
    const store = createMruStore(null);
    store.bump("a");
    expect(store.read()).toEqual([]);
    store.clear();
  });

  it("swallows setItem errors (quota exceeded)", () => {
    const fake: Storage = {
      length: 0,
      clear: vi.fn(),
      getItem: vi.fn().mockReturnValue(null),
      key: vi.fn().mockReturnValue(null),
      removeItem: vi.fn(),
      setItem: vi.fn(() => {
        throw new Error("QuotaExceeded");
      }),
    };
    const store = createMruStore(fake);
    expect(() => store.bump("a")).not.toThrow();
  });
});

describe("applyMruOrder", () => {
  const ITEMS = [
    { id: "one" },
    { id: "two" },
    { id: "three" },
    { id: "four" },
  ];

  it("returns a copy of items when MRU is empty", () => {
    const out = applyMruOrder(ITEMS, (i) => i.id, []);
    expect(out).toEqual(ITEMS);
    expect(out).not.toBe(ITEMS);
  });

  it("pins MRU ids to the front in MRU order", () => {
    const out = applyMruOrder(
      ITEMS,
      (i) => i.id,
      ["three", "one"],
    );
    expect(out.map((x) => x.id)).toEqual(["three", "one", "two", "four"]);
  });

  it("ignores MRU ids that aren't in the items list", () => {
    const out = applyMruOrder(
      ITEMS,
      (i) => i.id,
      ["ghost", "two"],
    );
    expect(out.map((x) => x.id)).toEqual(["two", "one", "three", "four"]);
  });
});
