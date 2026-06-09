import { useCallback, useEffect, useState } from "react";
import { deleteTask, inTauri, listTasks, saveTask } from "./ipc";
import type { Task } from "./types";

export interface UseTasks {
  tasks: Task[];
  refresh: () => Promise<void>;
  create: (name: string) => Promise<Task | null>;
  remove: (id: string) => Promise<void>;
}

export interface TaskMap {
  byId: Record<string, Task>;
  refresh: () => Promise<void>;
}

/**
 * All tasks (local + remote), keyed by id, so a view holding only an
 * entry's `taskId` can resolve the task — its name and remote-link fields
 * (#110). Refresh after attributing an entry, which interns a new task.
 */
export function useTaskMap(): TaskMap {
  const [byId, setById] = useState<Record<string, Task>>({});

  const refresh = useCallback(async () => {
    if (!inTauri) {
      setById({});
      return;
    }
    try {
      const tasks = await listTasks(null);
      setById(Object.fromEntries(tasks.map((t) => [t.id, t])));
    } catch (e) {
      console.error("list_tasks failed", e);
      setById({});
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { byId, refresh };
}

/**
 * Project-scoped tasks for the Data tab. Reloads whenever `projectId`
 * changes; create/remove operate on that project. A null projectId
 * yields an empty list (no project selected).
 */
export function useTasks(projectId: string | null): UseTasks {
  const [tasks, setTasks] = useState<Task[]>([]);

  const refresh = useCallback(async () => {
    if (!inTauri || !projectId) {
      setTasks([]);
      return;
    }
    try {
      setTasks(await listTasks(projectId));
    } catch (e) {
      console.error("list_tasks failed", e);
      setTasks([]);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(
    async (name: string): Promise<Task | null> => {
      const trimmed = name.trim();
      if (!projectId || !trimmed) return null;
      if (!inTauri) {
        const local: Task = {
          id: `local-task-${trimmed.toLowerCase().replace(/\s+/g, "-")}`,
          projectId,
          name: trimmed,
          archived: false,
        };
        setTasks((prev) =>
          prev.some((t) => t.id === local.id) ? prev : [...prev, local],
        );
        return local;
      }
      const saved = await saveTask({ projectId, name: trimmed });
      setTasks((prev) => [...prev.filter((t) => t.id !== saved.id), saved]);
      return saved;
    },
    [projectId],
  );

  const remove = useCallback(async (id: string): Promise<void> => {
    if (inTauri) await deleteTask(id);
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { tasks, refresh, create, remove };
}
