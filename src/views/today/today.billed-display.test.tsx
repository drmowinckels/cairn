import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

const BILLED_ENTRY = {
  id: "e1",
  projectId: "cairn",
  taskId: null,
  description: "billed work",
  startedAt: "2026-05-26T09:00:00Z",
  endedAt: "2026-05-26T10:00:00Z",
  source: "manual",
  ruleId: null,
};
const UNBILLED_ENTRY = {
  id: "e2",
  projectId: "cairn",
  taskId: null,
  description: "fresh work",
  startedAt: "2026-05-26T08:00:00Z",
  endedAt: "2026-05-26T08:30:00Z",
  source: "manual",
  ruleId: null,
};
const RUNNING_ENTRY = {
  id: "e3",
  projectId: "cairn",
  taskId: null,
  description: "in progress",
  startedAt: "2026-05-26T11:00:00Z",
  endedAt: null,
  source: "manual",
  ruleId: null,
};

// The day's entries — set per test. A *fresh* array per render keeps the
// billed-map effect honest: a regressed unstable dependency would loop (caught
// by the "exactly once" assertion below).
const today = vi.hoisted(() => ({ entries: [] as unknown[] }));
vi.mock("../../lib/use-today", () => ({
  useToday: () => ({
    entries: [...today.entries],
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  }),
}));

vi.mock("../../lib/use-tasks", () => ({
  useTaskMap: () => ({
    byId: {},
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}));

// The billing plugin's enabled state — flipped per test.
const billing = vi.hoisted(() => ({
  status: { enabled: true, license: null } as {
    enabled: boolean;
    license: unknown;
  } | null,
}));
vi.mock("../../lib/use-billing", () => ({
  useBilling: () => ({
    status: billing.status,
    busy: false,
    error: null,
    activate: vi.fn(),
    refresh: vi.fn(),
    deactivate: vi.fn(),
  }),
}));

const entriesBillingStatus = vi.fn();
vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    entriesBillingStatus: (...a: unknown[]) => entriesBillingStatus(...a),
  };
});

// Capture the billed number seeded into the editor.
const modalProps = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./manual-entry-modal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./manual-entry-modal")>();
  return {
    ...actual,
    ManualEntryModal: (props: { billedInvoiceNumber?: string | null }) => {
      modalProps.current = props;
      return <div data-testid="modal" />;
    },
  };
});

import { TodayView } from "./index";

beforeEach(() => {
  today.entries = [BILLED_ENTRY, UNBILLED_ENTRY];
});

afterEach(() => {
  vi.clearAllMocks();
  modalProps.current = null;
  billing.status = { enabled: true, license: null };
});

describe("TodayView — billed-on indicator (#287)", () => {
  it("chips only the invoiced row and asks about the day's closed entries", async () => {
    entriesBillingStatus.mockResolvedValue({ e1: "INV-0009" });
    render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(document.querySelector(".entry-billed")).toBeTruthy(),
    );
    const chips = document.querySelectorAll(".entry-billed");
    expect(chips.length).toBe(1);
    expect(chips[0].textContent).toContain("INV-0009");
    // Asked about the closed entries.
    expect(entriesBillingStatus).toHaveBeenCalledWith(
      expect.arrayContaining(["e1", "e2"]),
    );
    // Pins the loop fix: the effect keys on a stable id-string, so it fetches
    // exactly once. A regressed unstable dep would re-fire it (asynchronously,
    // past React's sync depth-guard) on every render — this catches that.
    expect(entriesBillingStatus).toHaveBeenCalledTimes(1);
  });

  it("seeds the editor's billed number when editing an invoiced entry", async () => {
    entriesBillingStatus.mockResolvedValue({ e1: "INV-0009" });
    render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(document.querySelector(".entry-billed")).toBeTruthy(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: /edit entry:.*billed work/i }),
    );
    expect(screen.getByTestId("modal")).toBeTruthy();
    expect(
      (modalProps.current as { billedInvoiceNumber?: string | null })
        .billedInvoiceNumber,
    ).toBe("INV-0009");

    // The unbilled row seeds null.
    fireEvent.click(
      screen.getByRole("button", { name: /edit entry:.*fresh work/i }),
    );
    expect(
      (modalProps.current as { billedInvoiceNumber?: string | null })
        .billedInvoiceNumber,
    ).toBeNull();
  });

  it("skips the lookup and shows no chip when billing is disabled", async () => {
    billing.status = { enabled: false, license: null };
    entriesBillingStatus.mockResolvedValue({ e1: "INV-0009" });
    render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
      />,
    );
    // The rows render, but the core activity log never reaches for billing.
    await screen.findByRole("button", { name: /edit entry:.*billed work/i });
    expect(entriesBillingStatus).not.toHaveBeenCalled();
    expect(document.querySelector(".entry-billed")).toBeNull();
  });

  it("omits chips without crashing when the lookup fails", async () => {
    entriesBillingStatus.mockRejectedValue(new Error("plugin off"));
    render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
      />,
    );
    await screen.findByRole("button", { name: /edit entry:.*billed work/i });
    // The failed lookup is swallowed (non-fatal) — the rows just show no chip.
    await waitFor(() => expect(entriesBillingStatus).toHaveBeenCalled());
    expect(document.querySelector(".entry-billed")).toBeNull();
  });

  it("looks up an empty set when the day has no closed entries", async () => {
    // Only a still-running entry → no closed ids → the effect passes [].
    today.entries = [RUNNING_ENTRY];
    entriesBillingStatus.mockResolvedValue({});
    render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
      />,
    );
    await waitFor(() => expect(entriesBillingStatus).toHaveBeenCalledWith([]));
    expect(document.querySelector(".entry-billed")).toBeNull();
  });

  it("discards a billing lookup that resolves after unmount", async () => {
    let resolve!: (v: Record<string, string>) => void;
    entriesBillingStatus.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { unmount } = render(
      <TodayView
        density="comfy"
        layoutVariant="default"
        onOpenRule={vi.fn()}
      />,
    );
    await waitFor(() => expect(entriesBillingStatus).toHaveBeenCalled());
    // Unmount before the lookup settles: the late result must be discarded
    // (the `alive` guard), not applied to an unmounted component.
    unmount();
    resolve({ e1: "INV-0009" });
    await Promise.resolve();
    expect(document.querySelector(".entry-billed")).toBeNull();
  });
});
