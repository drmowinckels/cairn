import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Project, RuleMatchEvent } from "../../lib/types";

const confirm = vi.fn().mockResolvedValue(undefined);
const dismiss = vi.fn().mockResolvedValue(undefined);

const SUGGESTION: RuleMatchEvent = {
  ruleId: "r1",
  ruleName: "Cairn dev",
  confidence: "suggestive",
  ambiguityBehavior: "prompt",
  project: "p1",
  tags: ["dev"],
  description: "",
};

const AURORA: Project = {
  id: "p1",
  name: "Aurora",
  clientId: null,
  color: "#123456",
  archived: false,
  estimateHours: null,
};

let suggestion: RuleMatchEvent | null = SUGGESTION;
let projectsById: Record<string, Project> = { p1: AURORA };

vi.mock("../../lib/use-notification-window", () => ({
  useNotificationWindow: () => ({ suggestion, projectsById, confirm, dismiss }),
}));

import { NotificationWindow } from "./notification-window";

beforeEach(() => {
  localStorage.clear();
  for (const key of Object.keys(document.documentElement.dataset)) {
    delete document.documentElement.dataset[key];
  }
});

afterEach(() => {
  vi.clearAllMocks();
  suggestion = SUGGESTION;
  projectsById = { p1: AURORA };
});

describe("NotificationWindow", () => {
  it("renders the suggestion body, project chip, and tags", () => {
    render(<NotificationWindow />);
    expect(screen.getByText(/Aurora/)).toBeTruthy();
    expect(screen.getByText(/Cairn dev/)).toBeTruthy();
    expect(screen.getByText("#dev")).toBeTruthy();
  });

  it("renders generic 'Detected' when the suggestion has no project", () => {
    suggestion = { ...SUGGESTION, project: null };
    render(<NotificationWindow />);
    expect(screen.getAllByText(/Detected/).length).toBeGreaterThan(0);
  });

  it("is a live region, not a dialog (no focus trap implied)", () => {
    render(<NotificationWindow />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const region = screen.getByRole("region", { name: /auto-detected work/i });
    expect(region.getAttribute("aria-live")).toBe("assertive");
  });

  it("confirms on the Confirm button", () => {
    render(<NotificationWindow />);
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("dismisses on the Dismiss button, the close button, and Escape", () => {
    render(<NotificationWindow />);
    fireEvent.click(screen.getByRole("button", { name: /^dismiss$/i }));
    expect(dismiss).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", { name: /dismiss suggestion/i }),
    );
    expect(dismiss).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(dismiss).toHaveBeenCalledTimes(3);
  });

  it("renders nothing when there is no suggestion", () => {
    suggestion = null;
    const { container } = render(<NotificationWindow />);
    expect(screen.queryByRole("region")).toBeNull();
    expect(container.querySelector(".notify-win")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("applies the stored a11y prefs to the document root", () => {
    localStorage.setItem(
      "cairn:a11y-prefs:v1",
      JSON.stringify({ theme: "dark", textScale: "xl" }),
    );
    render(<NotificationWindow />);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.textScale).toBe("xl");
  });
});
