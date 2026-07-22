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

const CAPABILITY = {
  network: { label: "Network", hint: "Makes network requests" },
  secrets: { label: "Secrets", hint: "Stores credentials in your keychain" },
  paid: {
    label: "Pro",
    hint: "Requires a paid license",
  },
} as const;

/** A capability surfaced to the user for a plugin or connector (mirrors the
 *  Rust `Capability`). Shown as a badge so a networked / secrets-bearing
 *  integration is never active silently — see docs/PRIVACY.md. */
export type Capability = keyof typeof CAPABILITY;

/** Capability badges for a plugin or connector, or a single "Local" badge
 *  when it declares none. Returns the inline badges only; the caller supplies
 *  the wrapping `.cap-badges` element. `emptyLabel` overrides the
 *  no-capability text (the import-consent dialog spells it out in full). */
export function CapabilityBadges({
  capabilities,
  emptyLabel = "Local",
}: {
  capabilities: readonly Capability[];
  emptyLabel?: string;
}) {
  if (capabilities.length === 0) {
    return <span className="cap-badge cap-badge--local">{emptyLabel}</span>;
  }
  return (
    <>
      {capabilities.map((cap) => (
        <span
          key={cap}
          className="cap-badge"
          title={CAPABILITY[cap].hint}
          aria-label={`${CAPABILITY[cap].label}: ${CAPABILITY[cap].hint}`}
        >
          {CAPABILITY[cap].label}
        </span>
      ))}
    </>
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
