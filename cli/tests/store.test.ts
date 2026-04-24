import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  statSync,
} from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";

const isWindows = platform() === "win32";
const describeUnix = isWindows ? describe.skip : describe;

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "revx-store-"));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

vi.mock("@revolut/revolut-x-api", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getConfigDir: () => tempDir,
    ensureConfigDir: () => {},
  };
});

const { createConnection, loadConnections } =
  await import("../src/db/store.js");

describeUnix("cli store file permissions", () => {
  it("createConnection writes telegram.json at 0o600", () => {
    createConnection("123:token", "42", "primary");
    const mode = statSync(join(tempDir, "telegram.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("self-heals a pre-existing telegram.json that is world-readable", () => {
    const path = join(tempDir, "telegram.json");
    writeFileSync(path, "[]", { mode: 0o600 });
    chmodSync(path, 0o644);
    expect(statSync(path).mode & 0o777).toBe(0o644);

    loadConnections();

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
