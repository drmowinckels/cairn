import type { ReactNode } from "react";
import { PROJECT_BY_ID } from "../test-fixtures/data";
import type { ProjectId } from "./types";

interface ProjectChipProps {
  id: ProjectId;
  size?: "sm" | "lg";
  interactive?: boolean;
  onClick?: () => void;
}

export function ProjectChip({ id, size = "sm", interactive, onClick }: ProjectChipProps) {
  const project = PROJECT_BY_ID[id];
  if (!project) return null;
  const dotSize = size === "lg" ? 8 : 6;
  return (
    <span
      className={`proj-chip proj-chip--${size}${interactive ? " is-interactive" : ""}`}
      onClick={onClick}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
    >
      <span
        className="proj-dot"
        style={{ width: dotSize, height: dotSize, background: project.color }}
      />
      <span className="proj-chip-name">{project.name}</span>
    </span>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return <span className="tag">#{children}</span>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function LocalBadge({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className="local-badge"
      title="All data stays on your machine. No telemetry, no accounts."
    >
      <span className="local-dot" />
      {compact ? "local" : "local only"}
    </span>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="mono">{children}</span>;
}
