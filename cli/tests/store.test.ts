import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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

describeUnix("cli store files that can't be read", () => {
  const canChmod = process.getuid?.() !== 0;

  it.skipIf(!canChmod)(
    "refuses a Telegram file it can't read instead of treating it as empty",
    () => {
      // given
      const path = join(tempDir, "telegram.json");
      writeFileSync(path, "[]", { mode: 0o600 });
      chmodSync(path, 0o000);

      // when
      const load = () => loadConnections();

      // then
      expect(load).toThrow(`${path} can't be read (EACCES).`);
      expect(() => createConnection("123:token", "42", "x")).toThrow(
        "can't be read",
      );
      chmodSync(path, 0o600);
    },
  );

  it("leaves no staging file behind after saving", () => {
    // when
    createConnection("123:token", "42", "primary");

    // then
    expect(readdirSync(tempDir)).toEqual(["telegram.json"]);
  });
});

describe("cli store files that are damaged", () => {
  it("refuses a damaged Telegram file instead of overwriting it", () => {
    // given
    const path = join(tempDir, "telegram.json");
    writeFileSync(path, "{ broken", { mode: 0o600 });

    // when
    const add = () => createConnection("123:token", "42", "x");

    // then
    expect(add).toThrow(`${path} is damaged, it is not a JSON list.`);
    expect(readFileSync(path, "utf-8")).toBe("{ broken");
  });

  it("reads an empty Telegram file as no connections", () => {
    // given
    writeFileSync(join(tempDir, "telegram.json"), "  \n", { mode: 0o600 });

    // then
    expect(loadConnections()).toEqual([]);
  });

  it("reads a Telegram file that starts with a byte order mark", () => {
    // given
    writeFileSync(join(tempDir, "telegram.json"), "\uFEFF[]", { mode: 0o600 });

    // then
    expect(loadConnections()).toEqual([]);
  });

  it.skipIf(isWindows)(
    "names a folder in place of the Telegram file and leaves its mode alone",
    () => {
      // given
      const path = join(tempDir, "telegram.json");
      mkdirSync(path, { mode: 0o755 });
      chmodSync(path, 0o755);

      // when
      const load = () => loadConnections();

      // then
      expect(load).toThrow(`${path} is a folder, not a file. Move it aside.`);
      expect(statSync(path).mode & 0o777).toBe(0o755);
    },
  );
});
