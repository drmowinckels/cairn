import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { Kbd, LocalBadge, Mono, ProjectChip, Tag } from "./components";

describe("ProjectChip", () => {
  it("renders project name + color dot for a known id", () => {
    const { container, getByText } = render(<ProjectChip id="cairn" />);
    expect(getByText("Cairn")).toBeTruthy();
    const dot = container.querySelector(".proj-dot") as HTMLElement;
    expect(dot).toBeTruthy();
    expect(dot.style.background).toBe("#f2cc8f");
    expect(dot.style.width).toBe("6px");
  });

  it("renders a larger dot in size=lg", () => {
    const { container } = render(<ProjectChip id="cairn" size="lg" />);
    const dot = container.querySelector(".proj-dot") as HTMLElement;
    expect(dot.style.width).toBe("8px");
    expect(container.querySelector(".proj-chip--lg")).toBeTruthy();
  });

  it("returns null for an unknown project id", () => {
    const { container } = render(
      <ProjectChip id={"does-not-exist" as never} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("becomes a button when interactive, and fires onClick", () => {
    const onClick = vi.fn();
    const { getByRole } = render(
      <ProjectChip id="cairn" interactive onClick={onClick} />,
    );
    const btn = getByRole("button");
    expect(btn.getAttribute("tabindex")).toBe("0");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("activates on Enter and Space when interactive", () => {
    const onClick = vi.fn();
    const { getByRole } = render(
      <ProjectChip id="cairn" interactive onClick={onClick} />,
    );
    const btn = getByRole("button");
    fireEvent.keyDown(btn, { key: "Enter" });
    fireEvent.keyDown(btn, { key: " " });
    expect(onClick).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(btn, { key: "a" });
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("ignores key presses when not interactive", () => {
    const onClick = vi.fn();
    const { container } = render(<ProjectChip id="cairn" onClick={onClick} />);
    const chip = container.querySelector(".proj-chip") as HTMLElement;
    fireEvent.keyDown(chip, { key: "Enter" });
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("Tag", () => {
  it("prefixes the label with a hash", () => {
    const { getByText } = render(<Tag>dev</Tag>);
    expect(getByText("#dev")).toBeTruthy();
  });
});

describe("Kbd", () => {
  it("renders as a <kbd> with the kbd class", () => {
    const { container } = render(<Kbd>⌘K</Kbd>);
    const kbd = container.querySelector("kbd");
    expect(kbd).toBeTruthy();
    expect(kbd?.classList.contains("kbd")).toBe(true);
    expect(kbd?.textContent).toBe("⌘K");
  });
});

describe("LocalBadge", () => {
  it("defaults to 'local only' with a tooltip", () => {
    const { getByText, container } = render(<LocalBadge />);
    expect(getByText("local only")).toBeTruthy();
    expect(
      container.querySelector(".local-badge")?.getAttribute("title"),
    ).toContain("stays on your machine");
  });

  it("shrinks to 'local' in compact mode", () => {
    const { getByText, queryByText } = render(<LocalBadge compact />);
    expect(getByText("local")).toBeTruthy();
    expect(queryByText("local only")).toBeNull();
  });
});

describe("Mono", () => {
  it("wraps children in a span with the mono class", () => {
    const { container } = render(<Mono>14:48</Mono>);
    const span = container.querySelector(".mono");
    expect(span?.textContent).toBe("14:48");
  });
});
