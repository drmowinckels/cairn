// Compute WCAG contrast matrix for Cairn brand tokens.
// Parses src/brand.css, resolves rgba on opaque surfaces, then prints a markdown table.

import { readFileSync } from "node:fs";
import {
  parseColor,
  parseVars,
  ratio,
  resolveVar,
} from "./contrast-lib.mjs";

const CSS = readFileSync(process.argv[2], "utf8");

function parseBlock(re) {
  const m = CSS.match(re);
  return m ? m[1] : "";
}

const rootBlock = parseBlock(/:root\s*\{([^}]+)\}/);
const darkBlock = parseBlock(/\[data-theme="dark"\]\s*\{([^}]+)\}/);
const hcLightBlock = parseBlock(
  /:root\[data-high-contrast="on"\]\s*\{([^}]+)\}/,
);
const hcDarkBlock = parseBlock(
  /:root\[data-high-contrast="on"\]\[data-theme="dark"\]\s*\{([^}]+)\}/,
);

const rootVars = parseVars(rootBlock);
const darkVars = parseVars(darkBlock);
const hcLightVars = parseVars(hcLightBlock);
const hcDarkVars = parseVars(hcDarkBlock);

function scopeFor(theme, highContrast) {
  const scope = { ...rootVars };
  if (theme === "dark") Object.assign(scope, darkVars);
  if (highContrast) {
    Object.assign(scope, hcLightVars);
    if (theme === "dark") Object.assign(scope, hcDarkVars);
  }
  return scope;
}

function resolveColor(name, scope) {
  const v = resolveVar(name, scope);
  return v ? parseColor(v) : null;
}

// Tokens used as `color:` on body / tertiary text. These must meet WCAG AA
// (4.5:1 body, 3:1 large) and HC mode 7:1.
const TEXT_TOKENS = [
  "--ink",
  "--ink-soft",
  "--ink-mute",
  "--accent-ink",
  "--teal-ink",
];
// Tokens reserved for fills, borders, dots, dividers, and icon strokes.
// They still appear in the matrix for reference but do not need to satisfy
// text contrast (3:1 vs surface is the relevant threshold for UI components).
const FILL_TOKENS = ["--ink-faint", "--accent", "--teal", "--indigo"];
const SURFACE_TOKENS = ["--bg", "--bg-soft", "--surface", "--surface-2"];
const ALL_TEXT = [...TEXT_TOKENS, ...FILL_TOKENS];

const rows = [];

for (const text of ALL_TEXT) {
  for (const surf of SURFACE_TOKENS) {
    const ratios = {};
    for (const [key, scope] of [
      ["light", scopeFor("light", false)],
      ["dark", scopeFor("dark", false)],
      ["hc-light", scopeFor("light", true)],
      ["hc-dark", scopeFor("dark", true)],
    ]) {
      const fg = resolveColor(text, scope);
      const bg = resolveColor(surf, scope);
      if (!fg || !bg) {
        ratios[key] = null;
        continue;
      }
      ratios[key] = ratio(fg, bg);
    }
    rows.push({ text, surf, ratios });
  }
}

function fmt(n) {
  if (n === null) return "—";
  return n.toFixed(2) + ":1";
}

function verdict(r) {
  if (FILL_TOKENS.includes(r.text)) return "n/a (fill/border only)";
  if (r.ratios.light === null || r.ratios.dark === null) return "n/a";
  const issues = [];
  if (r.ratios.light < 4.5)
    issues.push(`light ${r.ratios.light.toFixed(2)} < 4.5`);
  if (r.ratios.dark < 4.5)
    issues.push(`dark ${r.ratios.dark.toFixed(2)} < 4.5`);
  if (r.ratios["hc-light"] !== null && r.ratios["hc-light"] < 7)
    issues.push(`hc-light ${r.ratios["hc-light"].toFixed(2)} < 7`);
  if (r.ratios["hc-dark"] !== null && r.ratios["hc-dark"] < 7)
    issues.push(`hc-dark ${r.ratios["hc-dark"].toFixed(2)} < 7`);
  return issues.length === 0 ? "PASS" : "FAIL: " + issues.join("; ");
}

let md =
  "| text token | surface token | light | dark | hc-light | hc-dark | verdict |\n";
md += "|---|---|---|---|---|---|---|\n";

for (const r of rows) {
  md += `| \`${r.text}\` | \`${r.surf}\` | ${fmt(r.ratios.light)} | ${fmt(r.ratios.dark)} | ${fmt(r.ratios["hc-light"])} | ${fmt(r.ratios["hc-dark"])} | ${verdict(r)} |\n`;
}

console.log(md);

const judged = rows.filter((r) => !FILL_TOKENS.includes(r.text));
const fails = judged.filter((r) => !verdict(r).startsWith("PASS")).length;
console.error(`\n${fails} / ${judged.length} text-token pairs fail`);
if (fails > 0) process.exit(1);
