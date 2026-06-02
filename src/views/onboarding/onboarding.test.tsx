import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  OnboardingView,
  ONBOARDING_STEPS,
  SEED_PROJECT_PRESETS,
  nextStep,
  prevStep,
  type OnboardingStep,
} from "./onboarding";

afterEach(() => {
  invokeMock.mockReset();
});

describe("step machine helpers", () => {
  it("walks welcome → permissions → projects → browser → done", () => {
    const sequence: OnboardingStep[] = ["welcome"];
    let current: OnboardingStep = "welcome";
    while (current !== "done") {
      current = nextStep(current);
      sequence.push(current);
    }
    expect(sequence).toEqual([
      "welcome",
      "permissions",
      "projects",
      "browser",
      "done",
    ]);
  });

  it("back stops at welcome", () => {
    expect(prevStep("welcome")).toBe("welcome");
    expect(prevStep("permissions")).toBe("welcome");
    expect(prevStep("projects")).toBe("permissions");
    expect(prevStep("browser")).toBe("projects");
    expect(prevStep("done")).toBe("browser");
  });

  it("nextStep from done stays at done", () => {
    expect(nextStep("done")).toBe("done");
  });
});

describe("OnboardingView", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("renders the welcome step with the four privacy guarantees", () => {
    render(<OnboardingView onComplete={async () => {}} />);
    expect(
      screen.getByRole("dialog", { name: /welcome to cairn/i }),
    ).toBeTruthy();
    expect(screen.getByText(/Everything is stored locally/i)).toBeTruthy();
    expect(
      screen.getByText(
        /No accounts\. No telemetry\. No background phone-home\./i,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Window titles are read locally/i)).toBeTruthy();
    expect(
      screen.getAllByText(/Source on GitHub/i).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("Next advances through every step then 'Finish' calls onComplete", async () => {
    const onComplete = vi.fn().mockResolvedValue(undefined);
    const saveSeedProject = vi.fn().mockResolvedValue(undefined);
    render(
      <OnboardingView
        onComplete={onComplete}
        saveSeedProject={saveSeedProject}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByRole("heading", { name: /permissions/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByRole("heading", { name: /^projects$/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    expect(
      screen.getByRole("heading", { name: /browser extension/i }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /finish/i }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(saveSeedProject).toHaveBeenCalledTimes(SEED_PROJECT_PRESETS.length);
  });

  it("Back walks the chain backwards", () => {
    render(<OnboardingView onComplete={async () => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByRole("heading", { name: /permissions/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^back$/i }));
    expect(
      screen.getByRole("heading", { name: /welcome to cairn/i }),
    ).toBeTruthy();
  });

  it("Back is disabled on the first step", () => {
    render(<OnboardingView onComplete={async () => {}} />);
    const back = screen.getByRole("button", { name: /^back$/i });
    expect(back.hasAttribute("disabled")).toBe(true);
  });

  it("'Skip onboarding' calls onComplete without persisting projects", async () => {
    const onComplete = vi.fn().mockResolvedValue(undefined);
    const saveSeedProject = vi.fn().mockResolvedValue(undefined);
    render(
      <OnboardingView
        onComplete={onComplete}
        saveSeedProject={saveSeedProject}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /skip onboarding/i }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(saveSeedProject).not.toHaveBeenCalled();
  });

  it("deselecting a seed project excludes it from the persisted set", async () => {
    const onComplete = vi.fn().mockResolvedValue(undefined);
    const saveSeedProject = vi.fn().mockResolvedValue(undefined);
    render(
      <OnboardingView
        onComplete={onComplete}
        saveSeedProject={saveSeedProject}
      />,
    );
    // Walk to projects step.
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));

    // Untick the first seed.
    const checkboxes = screen.getAllByRole("checkbox");
    const firstSeedToggle = checkboxes.find((c) =>
      /include "Personal"/i.test(c.getAttribute("aria-label") ?? ""),
    )!;
    fireEvent.click(firstSeedToggle);

    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    fireEvent.click(screen.getByRole("button", { name: /finish/i }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(saveSeedProject).toHaveBeenCalledTimes(
      SEED_PROJECT_PRESETS.length - 1,
    );
    const names = saveSeedProject.mock.calls.map(
      (c) => (c[0] as { name: string }).name,
    );
    expect(names).not.toContain("Personal");
  });

  it("renaming a seed propagates to the persisted payload", async () => {
    const onComplete = vi.fn().mockResolvedValue(undefined);
    const saveSeedProject = vi.fn().mockResolvedValue(undefined);
    render(
      <OnboardingView
        onComplete={onComplete}
        saveSeedProject={saveSeedProject}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));

    const firstInput = screen.getByLabelText(
      /project name 1/i,
    ) as HTMLInputElement;
    fireEvent.change(firstInput, { target: { value: "Side gig" } });

    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    fireEvent.click(screen.getByRole("button", { name: /finish/i }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    const names = saveSeedProject.mock.calls.map(
      (c) => (c[0] as { name: string }).name,
    );
    expect(names).toContain("Side gig");
  });

  it("Escape triggers skip", async () => {
    const onComplete = vi.fn().mockResolvedValue(undefined);
    render(<OnboardingView onComplete={onComplete} />);
    fireEvent.keyDown(
      screen.getByRole("dialog", { name: /welcome to cairn/i }),
      { key: "Escape" },
    );
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });

  it("surfaces a finalize error in an alert without dismissing the dialog", async () => {
    const onComplete = vi
      .fn()
      .mockRejectedValueOnce(new Error("DB exploded"))
      .mockResolvedValueOnce(undefined);
    render(
      <OnboardingView
        onComplete={onComplete}
        saveSeedProject={async () => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    fireEvent.click(screen.getByRole("button", { name: /finish/i }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("DB exploded"),
    );
    // Dialog still mounted.
    expect(
      screen.getByRole("dialog", { name: /browser extension/i }),
    ).toBeTruthy();
  });

  it("progress dots reflect the current step index", () => {
    render(<OnboardingView onComplete={async () => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    const dots = document.querySelectorAll(".onboarding-progress-dot");
    expect(dots).toHaveLength(ONBOARDING_STEPS.length);
    // First two should be active after a single Next click.
    expect(dots[0].classList.contains("is-active")).toBe(true);
    expect(dots[1].classList.contains("is-active")).toBe(true);
    expect(dots[2].classList.contains("is-active")).toBe(false);
  });
});
