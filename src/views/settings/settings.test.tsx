import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();
const askMock = vi.fn();
const openMock = vi.fn();
const saveMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: (...args: unknown[]) => askMock(...args),
  open: (...args: unknown[]) => openMock(...args),
  save: (...args: unknown[]) => saveMock(...args),
}));

import { SettingsView } from "./index";
import type { UseA11yPrefs } from "../../lib/use-a11y-prefs";
import type { UseSignalCapture } from "../../lib/use-signal-capture";

type WithInternals = { __TAURI_INTERNALS__?: unknown };

function stubA11y(overrides: Partial<UseA11yPrefs> = {}): UseA11yPrefs {
  return {
    theme: "system",
    textScale: "md",
    highContrast: false,
    reduceMotion: false,
    colorblindSafe: false,
    announce: true,
    alwaysFocusRing: false,
    detectionPrompts: "subtle",
    ambiguityDefault: "prompt",
    setTheme: vi.fn(),
    setTextScale: vi.fn(),
    setHighContrast: vi.fn(),
    setReduceMotion: vi.fn(),
    setColorblindSafe: vi.fn(),
    setAnnounce: vi.fn(),
    setAlwaysFocusRing: vi.fn(),
    setDetectionPrompts: vi.fn(),
    setAmbiguityDefault: vi.fn(),
    ...overrides,
  };
}

function stubCapture(overrides: Partial<UseSignalCapture> = {}): UseSignalCapture {
  return {
    status: { active: false, path: null, bytesWritten: 0 },
    error: null,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    ...overrides,
  };
}

beforeEach(() => {
  invokeMock.mockReset();
  askMock.mockReset();
  openMock.mockReset();
  saveMock.mockReset();
});

afterEach(() => {
  delete (globalThis as WithInternals).__TAURI_INTERNALS__;
});

describe("SettingsView (browser-dev mode)", () => {
  it("renders the four privacy guarantees verbatim from PRIVACY.md", () => {
    render(<SettingsView density="comfy" a11y={stubA11y()} capture={stubCapture()} />);
    expect(
      screen.getByText(/Everything is stored locally/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/SQLite database under ~\/\.cairn\//i),
    ).toBeTruthy();
    expect(
      screen.getByText(/No accounts\. No telemetry\. No background phone-home\./i),
    ).toBeTruthy();
    expect(
      screen.getByText(/Window titles are read locally and never leave the device\./i),
    ).toBeTruthy();
    expect(
      screen.getByText(/Source on GitHub, Apache 2\.0 licensed\./i),
    ).toBeTruthy();
  });

  it("renders the Source on GitHub · Apache-2.0 attribution with a real link", () => {
    render(<SettingsView density="comfy" a11y={stubA11y()} capture={stubCapture()} />);
    const link = screen.getByRole("link", { name: /source on github/i });
    expect(link.getAttribute("href")).toBe(
      "https://github.com/drmowinckels/cairn",
    );
    expect(link.getAttribute("rel")).toMatch(/noopener/);
  });

  it("renders an exclusion list (or its empty hint) with at least one signal", () => {
    const { container } = render(
      <SettingsView density="comfy" a11y={stubA11y()} capture={stubCapture()} />,
    );
    // Either there's an exclusion list section, OR the empty hint is shown.
    expect(
      container.querySelector(".excl-list, .settings-block"),
    ).toBeTruthy();
  });

  it("clicking an accessibility toggle calls the matching a11y setter", () => {
    const a11y = stubA11y({ highContrast: false });
    render(<SettingsView density="comfy" a11y={a11y} capture={stubCapture()} />);
    const sw = screen.getByRole("switch", { name: /high contrast/i });
    fireEvent.click(sw);
    expect(a11y.setHighContrast).toHaveBeenCalledWith(true);
  });

  it("renders the Theme control with the current pref checked", () => {
    const a11y = stubA11y({ theme: "dark" });
    render(<SettingsView density="comfy" a11y={a11y} capture={stubCapture()} />);
    const group = screen.getByRole("radiogroup", { name: /^theme$/i });
    expect(group).toBeTruthy();
    const dark = screen.getByRole("radio", { name: /^dark$/i });
    expect(dark.getAttribute("aria-checked")).toBe("true");
  });

  it("selecting a theme calls setTheme with the chosen pref", () => {
    const a11y = stubA11y({ theme: "system" });
    render(<SettingsView density="comfy" a11y={a11y} capture={stubCapture()} />);
    fireEvent.click(screen.getByRole("radio", { name: /^dark$/i }));
    expect(a11y.setTheme).toHaveBeenCalledWith("dark");
  });

  it("adding an exclusion infers the kind and calls save_exclusion", () => {
    invokeMock.mockResolvedValue({ id: "n", kind: "domain", value: "mail.proton.me" });
    render(<SettingsView density="comfy" a11y={stubA11y()} capture={stubCapture()} />);
    const input = screen.getByLabelText(/add exclusion/i);
    fireEvent.change(input, { target: { value: "mail.proton.me" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(invokeMock).toHaveBeenCalledWith("save_exclusion", {
      input: { kind: "domain", value: "mail.proton.me" },
    });
  });

  it("the incognito pause toggle persists its state to localStorage", () => {
    window.localStorage.removeItem("cairn:pause-on-incognito:v1");
    render(<SettingsView density="comfy" a11y={stubA11y()} capture={stubCapture()} />);
    const cb = screen.getByRole("checkbox", { name: /private\/incognito/i });
    expect((cb as HTMLInputElement).checked).toBe(true);
    fireEvent.click(cb);
    expect(window.localStorage.getItem("cairn:pause-on-incognito:v1")).toBe("false");
  });

  it("renders the text-scale segmented control with the active option highlighted", () => {
    render(
      <SettingsView density="comfy" a11y={stubA11y({ textScale: "lg" })} capture={stubCapture()} />,
    );
    const group = screen.getByRole("radiogroup", { name: /text size/i });
    const active = Array.from(
      group.querySelectorAll<HTMLElement>('[role="radio"]'),
    ).find((b) => b.getAttribute("aria-checked") === "true");
    expect(active).toBeTruthy();
  });

  it("hides the popover-size control when no popoverSize prop is given", () => {
    render(<SettingsView density="comfy" a11y={stubA11y()} capture={stubCapture()} />);
    expect(screen.queryByRole("radiogroup", { name: /popover size/i })).toBeNull();
  });

  it("renders the popover-size control and drives setSize", () => {
    const setSize = vi.fn();
    render(
      <SettingsView
        density="comfy"
        a11y={stubA11y()}
        capture={stubCapture()}
        popoverSize={{ size: "compact", setSize }}
      />,
    );
    const group = screen.getByRole("radiogroup", { name: /popover size/i });
    const compact = screen.getByRole("radio", { name: /compact/i });
    expect(compact.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: /large/i }));
    expect(setSize).toHaveBeenCalledWith("large");
    expect(group).toBeTruthy();
  });

  it("hides the tray-detail toggle when no trayDetail prop is given", () => {
    render(<SettingsView density="comfy" a11y={stubA11y()} capture={stubCapture()} />);
    expect(
      screen.queryByRole("switch", { name: /show project in menu bar/i }),
    ).toBeNull();
  });

  it("renders the tray-detail toggle and drives setEnabled", () => {
    const setEnabled = vi.fn();
    render(
      <SettingsView
        density="comfy"
        a11y={stubA11y()}
        capture={stubCapture()}
        trayDetail={{ enabled: false, setEnabled }}
      />,
    );
    const sw = screen.getByRole("switch", { name: /show project in menu bar/i });
    fireEvent.click(sw);
    expect(setEnabled).toHaveBeenCalledWith(true);
  });

  it("renders the Default ambiguity behaviour segmented control with the active option highlighted", () => {
    render(
      <SettingsView
        density="comfy"
        a11y={stubA11y({ ambiguityDefault: "log-to-uncategorized" })}
        capture={stubCapture()}
      />,
    );
    const group = screen.getByRole("radiogroup", {
      name: /default ambiguity behaviour/i,
    });
    const active = Array.from(
      group.querySelectorAll<HTMLElement>('[role="radio"]'),
    ).find((b) => b.getAttribute("aria-checked") === "true");
    expect(active?.textContent).toMatch(/Uncategorized/i);
  });

  it("clicking an ambiguity option calls setAmbiguityDefault with the new value", () => {
    const a11y = stubA11y({ ambiguityDefault: "prompt" });
    render(<SettingsView density="comfy" a11y={a11y} capture={stubCapture()} />);
    const group = screen.getByRole("radiogroup", {
      name: /default ambiguity behaviour/i,
    });
    const skipBtn = Array.from(
      group.querySelectorAll<HTMLElement>('[role="radio"]'),
    ).find((b) => b.textContent === "Skip");
    expect(skipBtn).toBeTruthy();
    fireEvent.click(skipBtn!);
    expect(a11y.setAmbiguityDefault).toHaveBeenCalledExactlyOnceWith("skip");
  });

  it("does not call IPC in browser-dev mode", async () => {
    render(<SettingsView density="comfy" a11y={stubA11y()} capture={stubCapture()} />);
    await waitFor(() => {});
    expect(invokeMock).not.toHaveBeenCalled();
  });

  describe("Shortcuts card (issue #33)", () => {
    it("renders one row per binding listed in SHORTCUTS", () => {
      render(
        <SettingsView density="comfy" a11y={stubA11y()} capture={stubCapture()} />,
      );
      const heading = screen.getByRole("heading", { name: /^shortcuts$/i });
      const section = heading.closest("section")!;
      const items = section.querySelectorAll("li[data-shortcut-id]");
      expect(items.length).toBe(6);
      const ids = Array.from(items).map((li) =>
        li.getAttribute("data-shortcut-id"),
      );
      expect(ids).toEqual([
        "toggle-popover",
        "toggle-timer",
        "command-palette",
        "switch-view",
        "confirm",
        "dismiss",
      ]);
    });

    it("renders each binding's keys as <Kbd> chips, verbatim", () => {
      render(
        <SettingsView density="comfy" a11y={stubA11y()} capture={stubCapture()} />,
      );
      const togglePopover = document.querySelector(
        'li[data-shortcut-id="toggle-popover"]',
      )!;
      const kbds = Array.from(togglePopover.querySelectorAll(".kbd")).map(
        (el) => el.textContent,
      );
      expect(kbds).toEqual(["⌃", "⌥", "T"]);

      const toggleTimer = document.querySelector(
        'li[data-shortcut-id="toggle-timer"]',
      )!;
      const ttKbds = Array.from(toggleTimer.querySelectorAll(".kbd")).map(
        (el) => el.textContent,
      );
      expect(ttKbds).toEqual(["⌃", "⌥", "␣"]);

      const switchView = document.querySelector(
        'li[data-shortcut-id="switch-view"]',
      )!;
      const svKbds = Array.from(switchView.querySelectorAll(".kbd")).map(
        (el) => el.textContent,
      );
      expect(svKbds).toEqual(["1", "4"]);
      // Range dash sits between the two Kbd chips so the user reads "1 – 4".
      expect(switchView.textContent).toContain("–");
    });

    it("does not render a fake 'Reset to defaults' shortcuts button", () => {
      // Shortcuts are display-only constants — there is nothing to
      // reset, so the no-op button was removed rather than left as a
      // control that does nothing.
      render(
        <SettingsView density="comfy" a11y={stubA11y()} capture={stubCapture()} />,
      );
      expect(
        screen.queryByRole("button", { name: /reset to defaults/i }),
      ).toBeNull();
    });
  });
});

describe("SettingsView · About / Capture raw signals", () => {
  it("renders the About section as the last block with version + diagnostics toggle", () => {
    render(
      <SettingsView density="comfy" a11y={stubA11y()} capture={stubCapture()} />,
    );
    const about = screen.getByRole("region", { name: /about/i });
    expect(about).toBeTruthy();
    expect(about.textContent).toContain("Cairn");
    expect(about.textContent).toContain("Capture raw signals");
    // The diagnostics copy action lives here too.
    expect(
      screen.getByRole("button", { name: /copy diagnostics/i }),
    ).toBeTruthy();
  });

  it("opens the confirmation dialog instead of starting capture immediately", async () => {
    const capture = stubCapture();
    render(<SettingsView density="comfy" a11y={stubA11y()} capture={capture} />);
    fireEvent.click(
      screen.getByRole("switch", { name: /capture raw signals/i }),
    );

    const dialog = await screen.findByTestId("capture-confirm");
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toMatch(
      /troubleshooting|writes|toggle is never persisted/i,
    );
    expect(capture.start).not.toHaveBeenCalled();
  });

  it("invokes capture.start() only after the confirmation button is pressed", async () => {
    const capture = stubCapture();
    render(<SettingsView density="comfy" a11y={stubA11y()} capture={capture} />);
    fireEvent.click(
      screen.getByRole("switch", { name: /capture raw signals/i }),
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: /I understand — capture for this session/i,
      }),
    );

    await waitFor(() => expect(capture.start).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByTestId("capture-confirm")).toBeNull(),
    );
  });

  it("cancelling the dialog does not start capture", async () => {
    const capture = stubCapture();
    render(<SettingsView density="comfy" a11y={stubA11y()} capture={capture} />);
    fireEvent.click(
      screen.getByRole("switch", { name: /capture raw signals/i }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /cancel/i }));
    await waitFor(() =>
      expect(screen.queryByTestId("capture-confirm")).toBeNull(),
    );
    expect(capture.start).not.toHaveBeenCalled();
  });

  it("clicking the toggle when active calls stop() without re-opening the dialog", () => {
    const capture = stubCapture({
      status: {
        active: true,
        path: "/tmp/cairn/debug-signals.ndjson",
        bytesWritten: 1,
      },
    });
    render(<SettingsView density="comfy" a11y={stubA11y()} capture={capture} />);
    expect(screen.queryByTestId("capture-confirm")).toBeNull();
    fireEvent.click(
      screen.getByRole("switch", { name: /capture raw signals/i }),
    );
    expect(capture.stop).toHaveBeenCalledTimes(1);
  });

  it("renders the on-disk path while capture is active", () => {
    const capture = stubCapture({
      status: {
        active: true,
        path: "/tmp/cairn/debug-signals.ndjson",
        bytesWritten: 256,
      },
    });
    render(<SettingsView density="comfy" a11y={stubA11y()} capture={capture} />);
    expect(screen.getByTestId("capture-path").textContent).toContain(
      "/tmp/cairn/debug-signals.ndjson",
    );
  });

  it("renders an error banner when capture.error is set", () => {
    const capture = stubCapture({ error: "boom" });
    render(<SettingsView density="comfy" a11y={stubA11y()} capture={capture} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("boom");
  });
});

describe("SettingsView — Run onboarding again (#31)", () => {
  it("clicking 'Run onboarding again' invokes the passed handler", () => {
    const onRerun = vi.fn().mockResolvedValue(undefined);
    render(
      <SettingsView
        density="comfy"
        a11y={stubA11y()}
        capture={stubCapture()}
        onRerunOnboarding={onRerun}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /run onboarding again/i }),
    );
    expect(onRerun).toHaveBeenCalledTimes(1);
  });

  it("the 'Run onboarding again' button is disabled when no handler is wired", () => {
    render(
      <SettingsView
        density="comfy"
        a11y={stubA11y()}
        capture={stubCapture()}
      />,
    );
    const btn = screen.getByRole("button", { name: /run onboarding again/i });
    expect(btn.hasAttribute("disabled")).toBe(true);
  });
});
