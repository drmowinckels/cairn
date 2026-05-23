import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const { invoke, IpcError } = await import("./ipc");

afterEach(() => {
  invokeMock.mockReset();
});

describe("ipc.invoke", () => {
  const schema = z.object({ ok: z.boolean(), count: z.number() });

  it("returns parsed data when the response matches the schema", async () => {
    invokeMock.mockResolvedValue({ ok: true, count: 3 });
    const result = await invoke("some_cmd", { a: 1 }, schema);
    expect(result).toEqual({ ok: true, count: 3 });
    expect(invokeMock).toHaveBeenCalledWith("some_cmd", { a: 1 });
  });

  it("throws IpcError when fields are missing", async () => {
    invokeMock.mockResolvedValue({ ok: true });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(invoke("some_cmd", undefined, schema)).rejects.toBeInstanceOf(
        IpcError,
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it("attaches zod issues and the raw payload to the error", async () => {
    const bad = { ok: "yes", count: "three" };
    invokeMock.mockResolvedValue(bad);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await invoke("some_cmd", undefined, schema);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(IpcError);
      const err = e as InstanceType<typeof IpcError>;
      expect(err.command).toBe("some_cmd");
      expect(err.received).toBe(bad);
      expect(err.issues.length).toBeGreaterThan(0);
      expect(err.message).toContain("some_cmd");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("propagates underlying invoke rejections unchanged", async () => {
    const boom = new Error("backend went bang");
    invokeMock.mockRejectedValue(boom);
    await expect(invoke("some_cmd", undefined, schema)).rejects.toBe(boom);
  });

  it("validates nullable responses correctly", async () => {
    const nullable = schema.nullable();
    invokeMock.mockResolvedValue(null);
    await expect(invoke("some_cmd", undefined, nullable)).resolves.toBeNull();
  });
});

describe("ipc command helpers (without Tauri runtime)", () => {
  it("listProjects returns [] when not in Tauri", async () => {
    const { listProjects } = await import("./ipc");
    await expect(listProjects()).resolves.toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("listToday returns [] when not in Tauri", async () => {
    const { listToday } = await import("./ipc");
    await expect(listToday()).resolves.toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("currentRunning returns null when not in Tauri", async () => {
    const { currentRunning } = await import("./ipc");
    await expect(currentRunning()).resolves.toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("hidePopover is a no-op when not in Tauri", async () => {
    const { hidePopover } = await import("./ipc");
    await expect(hidePopover()).resolves.toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("ipc command helpers (inside Tauri)", () => {
  // The inTauri branch is decided at module-load time from
  // window.__TAURI_INTERNALS__, so we set the flag, re-import the
  // module, run the assertion, and restore the global afterwards.
  type WithInternals = { __TAURI_INTERNALS__?: unknown };
  let originalInternals: unknown;

  beforeEach(() => {
    originalInternals = (globalThis as WithInternals).__TAURI_INTERNALS__;
    (globalThis as WithInternals).__TAURI_INTERNALS__ = {};
    vi.resetModules();
  });

  afterEach(() => {
    if (originalInternals === undefined) {
      delete (globalThis as WithInternals).__TAURI_INTERNALS__;
    } else {
      (globalThis as WithInternals).__TAURI_INTERNALS__ = originalInternals;
    }
    vi.resetModules();
  });

  it("listProjects validates the backend response", async () => {
    invokeMock.mockResolvedValue([
      { id: "p1", name: "Cairn", client: null, color: "#e07a5f" },
    ]);
    const { listProjects } = await import("./ipc");
    const projects = await listProjects();
    expect(projects).toEqual([
      { id: "p1", name: "Cairn", client: null, color: "#e07a5f" },
    ]);
    expect(invokeMock).toHaveBeenCalledWith("list_projects", undefined);
  });

  it("listProjects rejects with IpcError on malformed response", async () => {
    invokeMock.mockResolvedValue([{ id: 1, name: 2 }]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // After vi.resetModules() the freshly-imported IpcError is a
      // distinct class, so we match on name instead of `instanceof`.
      const { listProjects } = await import("./ipc");
      const thrown = await listProjects().then(
        () => null,
        (e: unknown) => e,
      );
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).name).toBe("IpcError");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("startEntry forwards the input payload and validates the result", async () => {
    invokeMock.mockResolvedValue({
      id: "e1",
      projectId: "p1",
      task: "work",
      startedAt: "2026-05-23T10:00:00Z",
      endedAt: null,
      source: "manual",
      ruleId: null,
      tags: [],
    });
    const { startEntry } = await import("./ipc");
    const entry = await startEntry({ projectId: "p1", task: "work" });
    expect(entry.id).toBe("e1");
    expect(invokeMock).toHaveBeenCalledWith("start_entry", {
      input: { projectId: "p1", task: "work" },
    });
  });

  it("exportBackup returns the destination path", async () => {
    invokeMock.mockResolvedValue("/tmp/cairn-backup.sqlite");
    const { exportBackup } = await import("./ipc");
    await expect(exportBackup("/tmp/cairn-backup.sqlite")).resolves.toBe(
      "/tmp/cairn-backup.sqlite",
    );
  });
});
