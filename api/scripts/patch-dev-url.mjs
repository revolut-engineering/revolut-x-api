import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, statSync } from "node:fs";

const PROD_URL = "https://revx.revolut.com";
const DEV_URL = "https://revx.revolut.codes";

const distDir = join(dirname(fileURLToPath(import.meta.url)), "../dist");

function patchDir(dir) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      patchDir(fullPath);
    } else if (entry.endsWith(".js") || entry.endsWith(".d.ts")) {
      const original = readFileSync(fullPath, "utf8");
      const patched = original.replaceAll(PROD_URL, DEV_URL);
      if (patched !== original) {
        writeFileSync(fullPath, patched);
        console.log(`Patched: ${fullPath}`);
      }
    }
  }
}

patchDir(distDir);
console.log(`Build target: ${DEV_URL}`);
