import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { SuggestWhy, truncateMiddle } from "./suggest-why";
import type { MatchedSignal } from "../../lib/types";

describe("SuggestWhy", () => {
  it("renders nothing when there are no matched signals", () => {
    const { container } = render(<SuggestWhy signals={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the matched signal values as mono code chips", () => {
    const signals: MatchedSignal[] = [
      { signal: "git.branch", value: "feat/rules-ui" },
      { signal: "ide.folder", value: "~/code/cairn" },
    ];
    const { container } = render(<SuggestWhy signals={signals} />);
    const codes = Array.from(container.querySelectorAll("code")).map(
      (c) => c.textContent,
    );
    expect(codes).toEqual(["feat/rules-ui", "~/code/cairn"]);
  });

  it("prefixes the evidence with 'because'", () => {
    const { container } = render(
      <SuggestWhy signals={[{ signal: "git.branch", value: "feat/x" }]} />,
    );
    expect(container.textContent ?? "").toMatch(/^because/);
  });

  it("labels non-branch signals (folder) and shows git.branch bare", () => {
    const { container } = render(
      <SuggestWhy
        signals={[
          { signal: "git.branch", value: "feat/rules-ui" },
          { signal: "ide.folder", value: "~/code/cairn" },
        ]}
      />,
    );
    const text = container.textContent ?? "";
    // Spec line: `because feat/rules-ui · folder ~/code/cairn`.
    expect(text).toContain("folder");
    expect(text).toContain("~/code/cairn");
    // git.branch is shown bare — no "branch" label word precedes it.
    expect(text).not.toContain("branch ");
  });

  it("renders a separator between multiple chips and none before the first", () => {
    const { container } = render(
      <SuggestWhy
        signals={[
          { signal: "app.name", value: "Zed" },
          { signal: "git.branch", value: "feat/x" },
        ]}
      />,
    );
    const separators = container.querySelectorAll(".suggest-why-sep");
    expect(separators.length).toBe(1);
  });

  it("truncates an over-long chip value with a middle ellipsis", () => {
    const long = "a".repeat(30) + "/" + "b".repeat(30);
    const { container } = render(
      <SuggestWhy signals={[{ signal: "window.title", value: long }]} />,
    );
    const chip = container.querySelector("code")?.textContent ?? "";
    expect(chip).toContain("…");
    expect(chip.length).toBeLessThan(long.length);
    expect(chip.length).toBeLessThanOrEqual(40);
    expect(chip.startsWith("a")).toBe(true);
    expect(chip.endsWith("b")).toBe(true);
    // The full value must not leak via title/aria attributes.
    expect(container.querySelector(`[title="${long}"]`)).toBeNull();
  });

  it("leaves a short chip value unchanged", () => {
    const short = "~/code/cairn";
    expect(truncateMiddle(short)).toBe(short);
    const { container } = render(
      <SuggestWhy signals={[{ signal: "ide.folder", value: short }]} />,
    );
    expect(container.querySelector("code")?.textContent).toBe(short);
  });

  it("labels a calendar event as a meeting", () => {
    const { container } = render(
      <SuggestWhy
        signals={[{ signal: "calendar.event", value: "Stand-up" }]}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("meeting");
    expect(text).toContain("Stand-up");
  });
});
