import { describe, expect, it, vi } from "vitest";
import type { KeyboardEvent, ReactNode } from "react";
import { fireEvent, render, renderHook } from "@testing-library/react";
import { focusableElements, useFocusTrap } from "./use-focus-trap";

function Harness({
  onEscape,
  children,
}: {
  onEscape: () => void;
  children?: ReactNode;
}) {
  const trap = useFocusTrap(onEscape);
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      data-testid="dialog"
      role="dialog"
      tabIndex={-1}
      ref={trap.ref}
      onKeyDown={trap.onKeyDown}
    >
      {children ?? (
        <>
          <button type="button">first</button>
          <button type="button">middle</button>
          <button type="button">last</button>
        </>
      )}
    </div>
  );
}

describe("focusableElements", () => {
  it("returns visible, enabled, tabbable descendants only", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    root.innerHTML = `
      <button id="a">a</button>
      <button id="b" disabled>b</button>
      <a id="c" href="#x">c</a>
      <span id="d" tabindex="-1">d</span>
      <input id="e" aria-hidden="true" />
    `;
    const ids = focusableElements(root).map((el) => el.id);
    // disabled (b), tabindex=-1 (d), aria-hidden (e) are excluded.
    expect(ids).toEqual(["a", "c"]);
    root.remove();
  });
});

describe("useFocusTrap", () => {
  it("calls onEscape on Escape", () => {
    const onEscape = vi.fn();
    const { getByTestId } = render(<Harness onEscape={onEscape} />);
    fireEvent.keyDown(getByTestId("dialog"), { key: "Escape" });
    expect(onEscape).toHaveBeenCalledOnce();
  });

  it("wraps focus from last to first on Tab", () => {
    const { getByTestId, getByText } = render(<Harness onEscape={vi.fn()} />);
    const last = getByText("last");
    last.focus();
    fireEvent.keyDown(getByTestId("dialog"), { key: "Tab" });
    expect(document.activeElement).toBe(getByText("first"));
  });

  it("wraps focus from first to last on Shift+Tab", () => {
    const { getByTestId, getByText } = render(<Harness onEscape={vi.fn()} />);
    const first = getByText("first");
    first.focus();
    fireEvent.keyDown(getByTestId("dialog"), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(getByText("last"));
  });

  it("leaves focus alone when tabbing in the middle", () => {
    const { getByTestId, getByText } = render(<Harness onEscape={vi.fn()} />);
    const middle = getByText("middle");
    middle.focus();
    fireEvent.keyDown(getByTestId("dialog"), { key: "Tab" });
    expect(document.activeElement).toBe(middle);
  });

  it("ignores other keys", () => {
    const onEscape = vi.fn();
    const { getByTestId, getByText } = render(<Harness onEscape={onEscape} />);
    getByText("middle").focus();
    fireEvent.keyDown(getByTestId("dialog"), { key: "a" });
    expect(onEscape).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(getByText("middle"));
  });

  it("is a no-op on Tab when there are no focusable children", () => {
    const { getByTestId } = render(
      <Harness onEscape={vi.fn()}>
        <span>no focusables here</span>
      </Harness>,
    );
    // Should not throw and should not move focus.
    fireEvent.keyDown(getByTestId("dialog"), { key: "Tab" });
    expect(document.activeElement).toBe(document.body);
  });

  it("is a no-op on Tab when the container ref is not attached", () => {
    const { result } = renderHook(() => useFocusTrap(vi.fn()));
    const preventDefault = vi.fn();
    result.current.onKeyDown({
      key: "Tab",
      shiftKey: false,
      preventDefault,
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent<HTMLDivElement>);
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
