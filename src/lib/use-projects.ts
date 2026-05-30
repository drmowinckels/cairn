import { useCallback, useEffect, useState } from "react";
import { inTauri, listProjects, saveProject, type SaveProjectInput } from "./ipc";
import type { Project } from "./types";
import { PROJECTS as FIXTURE_PROJECTS } from "../test-fixtures/data";

export interface UseProjects {
  projects: Project[];
  refresh: () => Promise<void>;
  create: (input: SaveProjectInput) => Promise<Project>;
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
        // Browser-dev: there's no backend, so synthesize a local project
        // from the fixture set so the create flow is exercisable.
        const local: Project = {
          id: `local-${input.name.trim().toLowerCase().replace(/\s+/g, "-")}`,
          name: input.name.trim(),
          clientId: input.clientId ?? null,
          color: input.color,
          archived: input.archived ?? false,
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

  return { projects, refresh, create };
}
