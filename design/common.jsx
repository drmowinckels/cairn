// common.jsx — shared bits: chips, icons, primitives.

const { useState, useEffect, useRef, useMemo } = React;

// ─── Icons ─────────────────────────────────────────────────────────────
// Hairline icons matching the refined-minimal aesthetic.

const Icon = ({ name, size = 16, stroke = 1.5, className = "" }) => {
  const s = size;
  const props = {
    width: s, height: s, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: stroke, strokeLinecap: "round",
    strokeLinejoin: "round", "aria-hidden": "true", className,
  };
  switch (name) {
    case "play":     return <svg {...props}><path d="M7 5l11 7-11 7V5z"/></svg>;
    case "stop":     return <svg {...props}><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>;
    case "pause":    return <svg {...props}><path d="M9 5v14M15 5v14"/></svg>;
    case "today":    return <svg {...props}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>;
    case "reports":  return <svg {...props}><path d="M4 19V9M10 19V5M16 19v-7M22 19H4"/></svg>;
    case "rules":    return <svg {...props}><path d="M4 7h7M4 12h12M4 17h9"/><circle cx="14" cy="7" r="2"/><circle cx="19" cy="17" r="2"/></svg>;
    case "settings": return <svg {...props}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>;
    case "check":    return <svg {...props}><path d="M5 12l4.5 4.5L19 7"/></svg>;
    case "x":        return <svg {...props}><path d="M6 6l12 12M18 6L6 18"/></svg>;
    case "plus":     return <svg {...props}><path d="M12 5v14M5 12h14"/></svg>;
    case "edit":     return <svg {...props}><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>;
    case "chevron-right": return <svg {...props}><path d="M9 6l6 6-6 6"/></svg>;
    case "chevron-down":  return <svg {...props}><path d="M6 9l6 6 6-6"/></svg>;
    case "lock":     return <svg {...props}><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>;
    case "branch":   return <svg {...props}><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 8v8M6 12a6 6 0 0 0 6-6h4"/></svg>;
    case "folder":   return <svg {...props}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>;
    case "globe":    return <svg {...props}><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>;
    case "calendar": return <svg {...props}><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>;
    case "sparkle":  return <svg {...props}><path d="M12 4v6M12 14v6M4 12h6M14 12h6"/></svg>;
    case "shield":   return <svg {...props}><path d="M12 3l8 3v6c0 4.5-3.4 8.5-8 9-4.6-.5-8-4.5-8-9V6l8-3z"/></svg>;
    case "moon":     return <svg {...props}><path d="M20 14a8 8 0 1 1-9-10 7 7 0 0 0 9 10z"/></svg>;
    case "type":     return <svg {...props}><path d="M4 7V5h16v2M9 19h6M12 5v14"/></svg>;
    case "drag":     return <svg {...props}><circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/></svg>;
    case "info":     return <svg {...props}><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v5h1"/></svg>;
    case "search":   return <svg {...props}><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>;
    case "command":  return <svg {...props}><path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/></svg>;
    case "keyboard": return <svg {...props}><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h12"/></svg>;
    case "list":     return <svg {...props}><path d="M4 6h16M4 12h16M4 18h10"/></svg>;
    case "grid":     return <svg {...props}><rect x="4" y="4" width="7" height="7"/><rect x="13" y="4" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/></svg>;
    case "arrow-right": return <svg {...props}><path d="M5 12h14M13 6l6 6-6 6"/></svg>;
    default: return null;
  }
};

// ─── Project chip ───────────────────────────────────────────────────────
const ProjectChip = ({ id, size = "sm", interactive = false, onClick }) => {
  const p = PROJECT_BY_ID[id];
  if (!p) return null;
  const dotSize = size === "lg" ? 8 : 6;
  return (
    <span
      className={`proj-chip proj-chip--${size}${interactive ? " is-interactive" : ""}`}
      onClick={onClick}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
    >
      <span className="proj-dot" style={{ width: dotSize, height: dotSize, background: p.color }} />
      <span className="proj-chip-name">{p.name}</span>
    </span>
  );
};

const Tag = ({ children }) => <span className="tag">#{children}</span>;

const Kbd = ({ children }) => <kbd className="kbd">{children}</kbd>;

// ─── Privacy badge ──────────────────────────────────────────────────────
const LocalBadge = ({ compact = false }) => (
  <span className="local-badge" title="All data stays on your machine. No telemetry, no accounts.">
    <span className="local-dot" />
    {compact ? "local" : "local only"}
  </span>
);

Object.assign(window, { Icon, ProjectChip, Tag, Kbd, LocalBadge });
