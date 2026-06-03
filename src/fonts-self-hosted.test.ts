import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Guards the no-phone-home contract (#146, docs/PRIVACY.md): fonts must
// be self-hosted and bundled, never fetched from the Google Fonts CDN at
// runtime. If someone re-adds a CDN <link>, this fails loudly.
describe("self-hosted fonts", () => {
  const read = (rel: string) =>
    readFileSync(resolve(process.cwd(), rel), "utf8");

  it("index.html makes no Google Fonts CDN request", () => {
    const html = read("index.html");
    expect(html).not.toMatch(/fonts\.googleapis\.com/);
    expect(html).not.toMatch(/fonts\.gstatic\.com/);
  });

  it("the entrypoint imports the vendored @fontsource woff2 CSS", () => {
    const main = read("src/main.tsx");
    expect(main).toMatch(/@fontsource-variable\/newsreader/);
    expect(main).toMatch(/@fontsource-variable\/geist\//);
    expect(main).toMatch(/@fontsource-variable\/geist-mono\//);
  });
});
