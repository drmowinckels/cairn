import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Icon, type IconName } from "./icon";

const NAMES: IconName[] = [
  "play",
  "stop",
  "pause",
  "today",
  "reports",
  "rules",
  "settings",
  "check",
  "x",
  "plus",
  "edit",
  "chevron-right",
  "chevron-down",
  "lock",
  "branch",
  "folder",
  "globe",
  "calendar",
  "sparkle",
  "shield",
  "moon",
  "type",
  "drag",
  "info",
  "search",
  "command",
  "keyboard",
  "list",
  "grid",
  "arrow-right",
];

describe("Icon", () => {
  it("renders an SVG for every supported name", () => {
    for (const name of NAMES) {
      const { container } = render(<Icon name={name} />);
      const svg = container.querySelector("svg");
      expect(svg, `icon ${name} should render an <svg>`).toBeTruthy();
      expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("respects custom size + stroke + className", () => {
    const { container } = render(
      <Icon name="play" size={32} stroke={2} className="hi" />,
    );
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("32");
    expect(svg.getAttribute("height")).toBe("32");
    expect(svg.getAttribute("stroke-width")).toBe("2");
    expect(svg.classList.contains("hi")).toBe(true);
  });

  it("renders decorative SVGs (aria-hidden)", () => {
    const { container } = render(<Icon name="search" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("role")).toBeNull();
  });
});
