// Pure functions for WCAG contrast calculation.
// No file I/O — everything takes strings or color records.

export function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
    a: 1,
  };
}

export function parseColor(val) {
  val = val.trim();
  if (val.startsWith("#")) return hexToRgb(val);
  const rgba = val.match(
    /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/,
  );
  if (rgba) {
    return {
      r: +rgba[1],
      g: +rgba[2],
      b: +rgba[3],
      a: rgba[4] !== undefined ? +rgba[4] : 1,
    };
  }
  return null;
}

export function blend(fg, bg) {
  const a = fg.a;
  return {
    r: Math.round(fg.r * a + bg.r * (1 - a)),
    g: Math.round(fg.g * a + bg.g * (1 - a)),
    b: Math.round(fg.b * a + bg.b * (1 - a)),
    a: 1,
  };
}

export function luminance({ r, g, b }) {
  const ch = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

export function ratio(fg, bg) {
  const opaqueFg = fg.a < 1 ? blend(fg, bg) : fg;
  const L1 = luminance(opaqueFg);
  const L2 = luminance(bg);
  const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (hi + 0.05) / (lo + 0.05);
}

export function parseVars(block) {
  const map = {};
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let m;
  while ((m = re.exec(block)) !== null) {
    map[m[1]] = m[2].trim();
  }
  return map;
}

export function resolveVar(name, scope) {
  let v = scope[name];
  if (!v) return null;
  while (v.startsWith("var(")) {
    const inner = v.match(/var\((--[a-z0-9-]+)\)/i);
    if (!inner) break;
    v = scope[inner[1]];
    if (!v) return null;
  }
  return v;
}
