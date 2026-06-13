/** A value to place in the treemap (e.g. a project's seconds). */
export interface TreemapDatum {
  key: string;
  value: number;
}

/** A placed tile in the `width`×`height` box, in the same units. */
export interface TreemapTile {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Squarified treemap: lay value-proportional tiles into a `width`×`height`
 * box, keeping each tile's aspect ratio near 1 so no project becomes an
 * unreadable sliver. Items with value ≤ 0 are dropped; tiles come out
 * largest-first. Pure — area-only, no rendering.
 */
export function squarify(
  data: TreemapDatum[],
  width: number,
  height: number,
): TreemapTile[] {
  const total = data.reduce((s, d) => s + Math.max(0, d.value), 0);
  if (total <= 0 || width <= 0 || height <= 0) return [];

  // Scale values so their sum equals the box area, then work in area units.
  const scale = (width * height) / total;
  const items = data
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value)
    .map((d) => ({ key: d.key, area: d.value * scale }));

  const tiles: TreemapTile[] = [];
  // The free rectangle still to be filled.
  let rx = 0;
  let ry = 0;
  let rw = width;
  let rh = height;

  let i = 0;
  while (i < items.length) {
    const side = Math.min(rw, rh);
    // Grow a row while appending the next item doesn't worsen its worst ratio.
    const row = [items[i]!];
    let j = i + 1;
    while (
      j < items.length &&
      worstRatio([...row, items[j]!], side) <= worstRatio(row, side)
    ) {
      row.push(items[j]!);
      j += 1;
    }

    const rowArea = row.reduce((s, r) => s + r.area, 0);
    if (rw <= rh) {
      // The row spans the width; lay tiles left→right.
      const rowH = rowArea / rw;
      let x = rx;
      for (const r of row) {
        const tileW = r.area / rowH;
        tiles.push({ key: r.key, x, y: ry, w: tileW, h: rowH });
        x += tileW;
      }
      ry += rowH;
      rh -= rowH;
    } else {
      // The row spans the height; lay tiles top→bottom.
      const rowW = rowArea / rh;
      let y = ry;
      for (const r of row) {
        const tileH = r.area / rowW;
        tiles.push({ key: r.key, x: rx, y, w: rowW, h: tileH });
        y += tileH;
      }
      rx += rowW;
      rw -= rowW;
    }
    i = j;
  }
  return tiles;
}

/** Black or white — whichever reads better on `bg` (a `#rgb`/`#rrggbb` colour),
 *  by WCAG relative-luminance contrast. Non-hex input (e.g. a CSS variable like
 *  the faint no-project fill) falls back to the app's default ink, which is
 *  dark — correct for a light fill. */
export function readableTextColor(bg: string): string {
  const rgb = parseHexColor(bg);
  if (!rgb) return "var(--ink)";
  const l = relativeLuminance(rgb);
  // WCAG contrast of white vs black against luminance `l`.
  const contrastWhite = 1.05 / (l + 0.05);
  const contrastBlack = (l + 0.05) / 0.05;
  return contrastWhite >= contrastBlack ? "#fff" : "#15171f";
}

function parseHexColor(s: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? m[1]!.replace(/./g, (c) => c + c) : m[1]!;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** The worst (largest) aspect ratio among a row of area-tiles laid along a side
 *  of length `side`. Lower is squarer. */
function worstRatio(row: { area: number }[], side: number): number {
  const sum = row.reduce((s, r) => s + r.area, 0);
  let max = 0;
  let min = Infinity;
  for (const r of row) {
    if (r.area > max) max = r.area;
    if (r.area < min) min = r.area;
  }
  const s2 = sum * sum;
  const side2 = side * side;
  return Math.max((side2 * max) / s2, s2 / (side2 * min));
}
