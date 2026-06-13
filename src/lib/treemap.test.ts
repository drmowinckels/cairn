import { describe, expect, it } from "vitest";
import { readableTextColor, squarify, type TreemapTile } from "./treemap";

const area = (t: TreemapTile) => t.w * t.h;

function within(tiles: TreemapTile[], width: number, height: number) {
  return tiles.every(
    (t) =>
      t.x >= -1e-6 &&
      t.y >= -1e-6 &&
      t.x + t.w <= width + 1e-6 &&
      t.y + t.h <= height + 1e-6,
  );
}

function overlaps(a: TreemapTile, b: TreemapTile): boolean {
  return (
    a.x < b.x + b.w - 1e-6 &&
    b.x < a.x + a.w - 1e-6 &&
    a.y < b.y + b.h - 1e-6 &&
    b.y < a.y + a.h - 1e-6
  );
}

describe("squarify", () => {
  it("returns no tiles for empty, all-zero, or degenerate boxes", () => {
    expect(squarify([], 100, 100)).toEqual([]);
    expect(squarify([{ key: "a", value: 0 }], 100, 100)).toEqual([]);
    expect(squarify([{ key: "a", value: 5 }], 0, 100)).toEqual([]);
    expect(squarify([{ key: "a", value: 5 }], 100, 0)).toEqual([]);
  });

  it("fills the whole box with a single tile", () => {
    const [tile] = squarify([{ key: "solo", value: 7 }], 600, 220);
    expect(tile).toMatchObject({ key: "solo", x: 0, y: 0, w: 600, h: 220 });
  });

  it("drops non-positive values and keeps the rest area-proportional", () => {
    const tiles = squarify(
      [
        { key: "a", value: 60 },
        { key: "zero", value: 0 },
        { key: "neg", value: -10 },
        { key: "b", value: 20 },
      ],
      600,
      220,
    );
    expect(tiles.map((t) => t.key).sort()).toEqual(["a", "b"]);
    const byKey = Object.fromEntries(tiles.map((t) => [t.key, t]));
    // a is 3× b's value, so ~3× the area.
    expect(area(byKey.a!) / area(byKey.b!)).toBeCloseTo(3, 1);
  });

  it("emits tiles largest-first and conserves total area", () => {
    const tiles = squarify(
      [
        { key: "small", value: 5 },
        { key: "big", value: 80 },
        { key: "mid", value: 15 },
      ],
      600,
      220,
    );
    expect(tiles[0]!.key).toBe("big");
    const total = tiles.reduce((s, t) => s + area(t), 0);
    expect(total).toBeCloseTo(600 * 220, 0);
  });

  it("keeps tiles inside the box and non-overlapping (wide box)", () => {
    const data = [
      { key: "a", value: 50 },
      { key: "b", value: 25 },
      { key: "c", value: 12 },
      { key: "d", value: 8 },
      { key: "e", value: 5 },
    ];
    const tiles = squarify(data, 600, 220);
    expect(tiles.length).toBe(5);
    expect(within(tiles, 600, 220)).toBe(true);
    for (let i = 0; i < tiles.length; i++) {
      for (let j = i + 1; j < tiles.length; j++) {
        expect(overlaps(tiles[i]!, tiles[j]!)).toBe(false);
      }
    }
  });

  it("groups similar-sized tiles into a shared row", () => {
    // Equal values: appending the next tile keeps the row squarer, so the
    // row-growth loop runs instead of giving each tile its own row.
    const data = Array.from({ length: 8 }, (_, i) => ({
      key: `p${i}`,
      value: 10,
    }));
    const tiles = squarify(data, 600, 220);
    expect(tiles.length).toBe(8);
    expect(within(tiles, 600, 220)).toBe(true);
    // Several tiles share a top edge — proof they landed in one row.
    const topRow = tiles.filter((t) => Math.abs(t.y) < 1e-6);
    expect(topRow.length).toBeGreaterThan(1);
  });

  it("lays out a tall box too (the other split direction)", () => {
    const data = [
      { key: "a", value: 50 },
      { key: "b", value: 25 },
      { key: "c", value: 12 },
      { key: "d", value: 8 },
    ];
    const tiles = squarify(data, 220, 600);
    expect(tiles.length).toBe(4);
    expect(within(tiles, 220, 600)).toBe(true);
  });
});

describe("readableTextColor", () => {
  it("returns white on a dark background", () => {
    expect(readableTextColor("#000")).toBe("#fff");
    expect(readableTextColor("#15171f")).toBe("#fff");
  });

  it("returns black on light backgrounds (incl. the yellow tile)", () => {
    expect(readableTextColor("#ffffff")).toBe("#000");
    expect(readableTextColor("#f2cc8f")).toBe("#000");
  });

  it("expands 3-digit hex and is case-insensitive", () => {
    expect(readableTextColor("#FFF")).toBe("#000");
    expect(readableTextColor("#abc")).toBe(readableTextColor("#aabbcc"));
  });

  it("falls back to the app ink for non-hex input (CSS variables)", () => {
    expect(readableTextColor("var(--ink-faint)")).toBe("var(--ink)");
    expect(readableTextColor("rgb(1,2,3)")).toBe("var(--ink)");
  });

  it("clears AA (≥4.5:1) on any fill — incl. the mid-tone dead zone", () => {
    const lin = (c: number) => {
      const x = c / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    const lum = (hx: string) => {
      const h =
        hx.length === 4 ? "#" + hx.slice(1).replace(/./g, (c) => c + c) : hx;
      return (
        0.2126 * lin(parseInt(h.slice(1, 3), 16)) +
        0.7152 * lin(parseInt(h.slice(3, 5), 16)) +
        0.0722 * lin(parseInt(h.slice(5, 7), 16))
      );
    };
    const contrast = (a: string, b: string) => {
      const [la, lb] = [lum(a), lum(b)];
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };
    // Includes the project palette plus mid-tones a user could pick that a
    // softer ink would fail (#777/#808080 sit in the dead band).
    const fills = [
      "#81b29a",
      "#f2cc8f",
      "#e07a5f",
      "#9a9bb0",
      "#c8b8e0",
      "#777777",
      "#808080",
      "#2e86c1",
      "#16a085",
      "#c0392b",
      "#0072b2",
      "#000000",
    ];
    for (const bg of fills) {
      expect(contrast(readableTextColor(bg), bg)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
