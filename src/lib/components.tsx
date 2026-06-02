import type { ReactNode } from "react";
import { cbColor } from "./colorblind";
import { useColorblindEnabled } from "./use-colorblind";
import type { Project } from "./types";

interface ProjectChipProps {
  project: Pick<Project, "name" | "color"> | null | undefined;
  size?: "sm" | "lg";
  interactive?: boolean;
  onClick?: () => void;
}

export function ProjectChip({
  project,
  size = "sm",
  interactive,
  onClick,
}: ProjectChipProps) {
  const cb = useColorblindEnabled();
  if (!project) return null;
  const dotSize = size === "lg" ? 8 : 6;
  return (
    <span
      className={`proj-chip proj-chip--${size}${interactive ? " is-interactive" : ""}`}
      onClick={onClick}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
    >
      <span
        className="proj-dot"
        style={{
          width: dotSize,
          height: dotSize,
          background: cbColor(project.color, cb),
        }}
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

interface EmptyProps {
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  tone?: "neutral" | "soft";
}

export function Empty({ title, body, action, tone = "neutral" }: EmptyProps) {
  return (
    <div className={`empty empty--${tone}`} role="status">
      <div className="empty-title">{title}</div>
      {body && <div className="empty-body">{body}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

interface ErrorBannerProps {
  message: string;
  onRetry?: () => void;
}

export function ErrorBanner({ message, onRetry }: ErrorBannerProps) {
  return (
    <div className="err-banner" role="alert">
      <span className="err-mark" aria-hidden="true">
        !
      </span>
      <span className="err-msg">{message}</span>
      {onRetry && (
        <button type="button" className="link-btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Skeleton({
  width = "100%",
  height = 16,
}: {
  width?: number | string;
  height?: number | string;
}) {
  return (
    <span className="skeleton" aria-hidden="true" style={{ width, height }} />
  );
}
