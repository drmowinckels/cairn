/**
 * Okabe–Ito 8-colour palette. Designed to remain distinguishable for
 * users with red-green or blue-yellow colour vision deficiencies, and
 * widely cited as the de-facto "accessible" qualitative scale (Okabe &
 * Ito 2008, "Color Universal Design").
 *
 * Mapped to the Cairn brand palette below so we can swap *display*
 * colours when `colorblindSafe` is on without mutating the underlying
 * `projects` table — the DB and CSV exports keep the user's chosen
 * brand colour. The CSS still applies hatch overlays on top of these
 * (see `:root[data-colorblind="on"]` in `brand.css`) so the swap
 * combines with non-colour cues.
 */
export const OKABE_ITO = [
  "#000000",
  "#E69F00",
  "#56B4E9",
  "#009E73",
  "#F0E442",
  "#0072B2",
  "#D55E00",
  "#CC79A7",
] as const;

const NORMALIZED_MAP: Record<string, string> = {
  "#81b29a": "#009E73",
  "#f2cc8f": "#E69F00",
  "#e07a5f": "#D55E00",
  "#9a9bb0": "#56B4E9",
  "#c8b8e0": "#CC79A7",
};

function normalizeHex(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("#")) return null;
  const hex = trimmed.slice(1);
  if (hex.length === 3) {
    return (
      "#" +
      hex
        .split("")
        .map((c) => (c + c).toLowerCase())
        .join("")
    );
  }
  if (hex.length === 6) return ("#" + hex).toLowerCase();
  return null;
}

function hashString(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Translate a project's stored colour to its display colour, applying
 * the Okabe–Ito swap iff `enabled` is true.
 *
 * Unknown / non-hex inputs (CSS variables, named colours, hand-edited
 * blobs) pass through unchanged when disabled, and resolve to a stable
 * Okabe–Ito slot by string hash when enabled — so two projects sharing
 * a non-hex colour still land on the same display colour, but a tweak
 * like trailing whitespace doesn't shuffle the whole palette.
 */
export function cbColor(input: string, enabled: boolean): string {
  if (!enabled) return input;
  const normalized = normalizeHex(input);
  if (normalized && NORMALIZED_MAP[normalized]) {
    return NORMALIZED_MAP[normalized];
  }
  const slot = hashString(normalized ?? input) % OKABE_ITO.length;
  return OKABE_ITO[slot];
}
