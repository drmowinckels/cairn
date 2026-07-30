-- Invoice template preset (#1). A named look — "classic" (default), "modern",
-- or "minimal" — bundling the exported invoice's colors, spacing, and type.
-- Only the name is stored; the stylesheets live in code. Empty falls back to
-- "classic" at render time. Plugin-owned.
ALTER TABLE billing_business ADD COLUMN template TEXT NOT NULL DEFAULT '';
