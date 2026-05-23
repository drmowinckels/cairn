// Headless accessibility audit for the Cairn renderer.
// Spawns `vite preview` against the prebuilt dist/, drives Chromium via
// puppeteer, injects a Tauri shim so the React tree renders normally,
// then runs axe-core on every tab in both colour schemes.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = join(__dirname, "..");
const AXE_PATH = join(REPO_DIR, "node_modules", "axe-core", "axe.min.js");
const PORT = Number(process.env.AUDIT_PORT ?? 4173);
const HOST = "127.0.0.1";

// The IPC response fixture lives in its own JSON file so a vitest test
// can parse it against the same schemas the runtime uses (catches drift
// between the audit fixtures and the real backend contract).
const IPC_FIXTURE_JSON = readFileSync(
  join(__dirname, "audit-a11y-ipc-fixture.json"),
  "utf8",
);

const TABS = ["Today", "Reports", "Rules", "Settings"];
const SCHEMES = ["light", "dark"];

const CONSOLE_LEVELS = new Set(["error", "warning"]);
// Patterns that match known-benign messages we don't want to fail on.
const CONSOLE_IGNORE = [
  /react-devtools/i,
  /download the react devtools/i,
  // Browser preview fetches assets that only exist when bundled by Tauri
  // (icon variants, plugin URLs). Real JS errors still surface via the
  // separate `pageerror` channel.
  /Failed to load resource:.*404/i,
];

const TAURI_SHIM = `
(() => {
  if (window.__TAURI_INTERNALS__) return;

  const RESPONSES = ${IPC_FIXTURE_JSON};
  const callbacks = {};

  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "popover" },
      currentWebview: { label: "popover" },
    },
    callbacks,
    invoke: (cmd) =>
      Promise.resolve(cmd in RESPONSES ? RESPONSES[cmd] : null),
    transformCallback: (cb, _once) => {
      const id = Math.floor(Math.random() * 1e9);
      callbacks[id] = cb;
      return id;
    },
    unregisterCallback: (id) => {
      delete callbacks[id];
    },
    runCallback: (id, ...args) => callbacks[id]?.(...args),
    convertFileSrc: (p) => p,
  };
})();
`;

async function startPreview() {
  const child = spawn(
    "npx",
    ["vite", "preview", "--port", String(PORT), "--host", HOST, "--strictPort"],
    { cwd: REPO_DIR, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (b) => process.stdout.write(b));
  child.stderr.on("data", (b) => process.stderr.write(b));

  const url = `http://${HOST}:${PORT}/`;
  const deadline = Date.now() + 30_000;
  let lastErr;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`vite preview exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(url, { method: "HEAD" });
      if (res.ok || res.status === 405) return child;
    } catch (e) {
      lastErr = e;
    }
    await sleep(200);
  }
  throw new Error(
    `vite preview did not respond on ${url} within 30s` +
      (lastErr ? `: ${lastErr.message}` : ""),
  );
}

async function stopPreview(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), sleep(3000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function auditTab(page, tab) {
  await page.evaluate((label) => {
    const buttons = Array.from(
      document.querySelectorAll('.pop-nav button[role="tab"]'),
    );
    const btn = buttons.find((b) => b.textContent?.trim().includes(label));
    btn?.click();
  }, tab);
  await sleep(150);

  await page.addScriptTag({ path: AXE_PATH });
  const violations = await page.evaluate(async () => {
    // Existing violations whose fixes are tracked under M5:
    //   - target-size           (WCAG 2.2 SC 2.5.8) — dense rule rows         → M5 #28
    //   - color-contrast        — see contrast audit                          → M5 #29
    //   - aria-allowed-attr     — segmented control / nested toggle attrs     → M5 #28
    //   - aria-required-children — `role="tablist"` with `<button>` children   → M5 #28
    //   - nested-interactive    — `.rule-head[role="button"]` contains buttons → M5 #28
    // Re-enable each rule as the linked issue lands. New a11y bugs introduced
    // by this PR or later PRs must NOT be added to this list — fix the bug.
    const results = await window.axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
      rules: {
        "target-size": { enabled: false },
        "color-contrast": { enabled: false },
        "aria-allowed-attr": { enabled: false },
        "aria-required-children": { enabled: false },
        "nested-interactive": { enabled: false },
      },
    });
    return results.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      helpUrl: v.helpUrl,
      nodes: v.nodes.map((n) => ({
        target: n.target,
        html: n.html.slice(0, 240),
        failureSummary: n.failureSummary,
        any: n.any?.map((a) => ({ id: a.id, message: a.message, data: a.data })),
      })),
    }));
  });
  return violations;
}

async function main() {
  let preview;
  let browser;
  const allViolations = [];
  const consoleNoise = [];

  try {
    preview = await startPreview();
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    for (const scheme of SCHEMES) {
      for (const tab of TABS) {
        const page = await browser.newPage();
        await page.evaluateOnNewDocument(TAURI_SHIM);
        page.on("console", (msg) => {
          const type = msg.type();
          if (!CONSOLE_LEVELS.has(type)) return;
          const text = msg.text();
          if (CONSOLE_IGNORE.some((rx) => rx.test(text))) return;
          consoleNoise.push({ scheme, tab, type, text });
        });
        page.on("pageerror", (err) => {
          consoleNoise.push({
            scheme,
            tab,
            type: "pageerror",
            text: err.stack || err.message,
          });
        });
        await page.emulateMediaFeatures([
          { name: "prefers-color-scheme", value: scheme },
        ]);
        await page.goto(`http://${HOST}:${PORT}/index.html`, {
          waitUntil: "networkidle0",
          timeout: 15_000,
        });
        await page.waitForSelector('.pop-nav button[role="tab"]', {
          timeout: 5_000,
        });

        const violations = await auditTab(page, tab);
        for (const v of violations) {
          allViolations.push({ scheme, tab, ...v });
        }
        await page.close();
      }
    }
  } finally {
    if (browser) await browser.close();
    if (preview) await stopPreview(preview);
  }

  const totalTabs = TABS.length * SCHEMES.length;

  if (consoleNoise.length > 0) {
    console.error(
      `\n✗ renderer console: ${consoleNoise.length} message(s) across ${totalTabs} audits`,
    );
    for (const m of consoleNoise) {
      console.error(`  [${m.scheme}] ${m.tab} (${m.type}): ${m.text}`);
    }
  }

  if (allViolations.length === 0 && consoleNoise.length === 0) {
    console.log(`\n✓ axe a11y: clean across ${totalTabs} (tab × scheme) audits`);
    console.log(`✓ renderer console: clean across ${totalTabs} audits`);
    process.exit(0);
  }

  if (allViolations.length === 0) {
    process.exit(1);
  }

  console.error(
    `\n✗ axe a11y: ${allViolations.length} violation(s) across ${totalTabs} audits\n`,
  );
  const grouped = new Map();
  for (const v of allViolations) {
    const key = `${v.id}|${v.impact}`;
    if (!grouped.has(key)) grouped.set(key, { ...v, occurrences: [] });
    grouped.get(key).occurrences.push({
      scheme: v.scheme,
      tab: v.tab,
      nodes: v.nodes,
    });
  }
  for (const [, v] of grouped) {
    console.error(`  ▸ ${v.id} (${v.impact ?? "n/a"}): ${v.help}`);
    console.error(`    ${v.helpUrl}`);
    for (const occ of v.occurrences) {
      console.error(`      [${occ.scheme}] ${occ.tab}`);
      for (const n of occ.nodes.slice(0, 3)) {
        console.error(`        ${n.target.join(" ")}`);
        if (n.html) console.error(`          ${n.html}`);
        for (const a of n.any ?? []) {
          if (a.data && typeof a.data === "object") {
            const d = a.data;
            const summary = [
              d.fgColor ? `fg=${d.fgColor}` : null,
              d.bgColor ? `bg=${d.bgColor}` : null,
              d.contrastRatio ? `ratio=${d.contrastRatio}` : null,
              d.expectedContrastRatio ? `need=${d.expectedContrastRatio}` : null,
              d.fontSize ? `size=${d.fontSize}` : null,
              d.fontWeight ? `weight=${d.fontWeight}` : null,
            ]
              .filter(Boolean)
              .join(" ");
            if (summary) console.error(`          ↳ ${summary}`);
          }
        }
      }
    }
  }
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
