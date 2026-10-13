import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API_PACKAGE = "@revolut/revolut-x-api";
const API_DIR = "api";

const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));
const writeJson = (path, value) =>
  writeFileSync(join(ROOT, path), `${JSON.stringify(value, null, 2)}\n`);

const manifestPath = (dir) => join(dir, "package.json");
const expected = `^${readJson(manifestPath(API_DIR)).version}`;
const dependents = readJson("package.json")
  .workspaces.filter((dir) => dir !== API_DIR)
  .filter(
    (dir) =>
      readJson(manifestPath(dir)).dependencies?.[API_PACKAGE] !== undefined,
  );

function write() {
  for (const dir of dependents) {
    const manifest = readJson(manifestPath(dir));
    manifest.dependencies[API_PACKAGE] = expected;
    writeJson(manifestPath(dir), manifest);
  }
  console.log(`Set ${API_PACKAGE} to ${expected} in ${dependents.join(", ")}`);
}

function check() {
  const lock = readJson("package-lock.json");
  const problems = dependents.flatMap((dir) => {
    const declared = readJson(manifestPath(dir)).dependencies[API_PACKAGE];
    const locked = lock.packages?.[dir]?.dependencies?.[API_PACKAGE];
    return [
      declared === expected
        ? null
        : `${dir}/package.json requires ${API_PACKAGE} ${declared}, expected ${expected} to match ${manifestPath(API_DIR)}.`,
      locked === declared
        ? null
        : `package-lock.json records ${locked ?? "nothing"} for ${dir}, while ${dir}/package.json requires ${declared}.`,
    ].filter((problem) => problem !== null);
  });
  if (problems.length === 0) {
    console.log(
      `OK: ${dependents.join(", ")} require ${API_PACKAGE} ${expected}`,
    );
    return;
  }
  problems.forEach((problem) => console.error(problem));
  console.error(
    "Run 'npm run api-range' and then 'npm install --package-lock-only'.",
  );
  process.exit(1);
}

switch (process.argv[2] ?? "check") {
  case "write":
    write();
    break;
  case "check":
    check();
    break;
  default:
    console.error("usage: node scripts/api-range.mjs [write|check]");
    process.exit(2);
}
