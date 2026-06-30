import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(resolve(here, "../assets/icon.svg"), "utf8");
const outDir = resolve(here, "../public/icon");
mkdirSync(outDir, { recursive: true });

const sizes = [16, 32, 48, 128];
const browser = await chromium.launch();
try {
  for (const size of sizes) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1
    });
    // Force the SVG to render at exactly `size`x`size` with no page margin.
    const sized = svg.replace(
      /<svg /,
      `<svg width="${size}" height="${size}" `
    );
    await page.setContent(
      `<!doctype html><html><body style="margin:0;padding:0">${sized}</body></html>`
    );
    await page.locator("svg").screenshot({
      path: resolve(outDir, `${size}.png`),
      omitBackground: true
    });
    await page.close();
    console.log(`wrote public/icon/${size}.png`);
  }
} finally {
  await browser.close();
}
