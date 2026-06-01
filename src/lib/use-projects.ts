import { useCallback, useEffect, useState } from "react";
import {
  deleteProject,
  inTauri,
  listProjects,
  saveProject,
  type SaveProjectInput,
} from "./ipc";
import type { Project } from "./types";
import { PROJECTS as FIXTURE_PROJECTS } from "../test-fixtures/data";

export interface UseProjects {
  projects: Project[];
  refresh: () => Promise<void>;
  create: (input: SaveProjectInput) => Promise<Project>;
  update: (input: SaveProjectInput & { id: string }) => Promise<Project>;
  remove: (id: string) => Promise<void>;
}

function localId(name: string): string {
  return `local-${name.trim().toLowerCase().replace(/\s+/g, "-")}`;
}

export function useProjects(): UseProjects {
  const [projects, setProjects] = useState<Project[]>(
    inTauri ? [] : FIXTURE_PROJECTS,
  );

  const refresh = useCallback(async () => {
    if (!inTauri) return;
    try {
      const p = await listProjects();
      setProjects(p.length ? p : FIXTURE_PROJECTS);
    } catch (e) {
      console.error("list_projects failed", e);
      setProjects(FIXTURE_PROJECTS);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(
    async (input: SaveProjectInput): Promise<Project> => {
      if (!inTauri) {
        // Browser-dev: synthesize a local project so the flow works.
        const local: Project = {
          id: localId(input.name),
          name: input.name.trim(),
          clientId: input.clientId ?? null,
          color: input.color,
          archived: input.archived ?? false,
          estimateHours: input.estimateHours ?? null,
        };
        setProjects((prev) =>
          prev.some((p) => p.id === local.id) ? prev : [...prev, local],
        );
        return local;
      }
      const saved = await saveProject(input);
      setProjects((prev) => [...prev.filter((p) => p.id !== saved.id), saved]);
      return saved;
    },
    [],
  );

  const update = useCallback(
    async (input: SaveProjectInput & { id: string }): Promise<Project> => {
      if (!inTauri) {
        const next: Project = {
          id: input.id,
          name: input.name.trim(),
          clientId: input.clientId ?? null,
          color: input.color,
          archived: input.archived ?? false,
          estimateHours: input.estimateHours ?? null,
        };
        setProjects((prev) => prev.map((p) => (p.id === next.id ? next : p)));
        return next;
      }
      const saved = await saveProject(input);
      setProjects((prev) => prev.map((p) => (p.id === saved.id ? saved : p)));
      return saved;
    },
    [],
  );

  const remove = useCallback(async (id: string): Promise<void> => {
    if (inTauri) await deleteProject(id);
    setProjects((prev) => prev.filter((p) => p.id !== id));
  }, []);

  return { projects, refresh, create, update, remove };
}
