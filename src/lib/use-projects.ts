import { useEffect, useState } from "react";
import { inTauri, listProjects } from "./ipc";
import type { Project } from "./types";
import { PROJECTS as FIXTURE_PROJECTS } from "../test-fixtures/data";

export function useProjects(): Project[] {
  const [projects, setProjects] = useState<Project[]>(
    inTauri ? [] : FIXTURE_PROJECTS,
  );

  useEffect(() => {
    if (!inTauri) return;
    let cancelled = false;
    listProjects()
      .then((p) => {
        if (!cancelled) setProjects(p.length ? p : FIXTURE_PROJECTS);
      })
      .catch(() => {
        if (!cancelled) setProjects(FIXTURE_PROJECTS);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return projects;
}
