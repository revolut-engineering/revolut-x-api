import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

const steps = vi.hoisted(() => [] as string[]);
const disk = vi.hoisted(() => ({
  fileSyncError: undefined as string | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      const folder = actual.fstatSync(fd).isDirectory();
      steps.push(folder ? "sync folder" : "sync");
      if (!folder && disk.fileSyncError) {
        throw Object.assign(new Error(`fsync ${disk.fileSyncError}`), {
          code: disk.fileSyncError,
        });
      }
      return actual.fsyncSync(fd);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      steps.push("rename");
      return actual.renameSync(...args);
    },
  };
});

const { writeFileAtomic } = await import("../src/config/settings.js");

const posix = platform() !== "win32";
const canChmod =
  posix && typeof process.getuid === "function"
    ? process.getuid() !== 0
    : false;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "revx-atomic-"));
  steps.length = 0;
  disk.fileSyncError = undefined;
});
afterEach(() => {
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  it.skipIf(!posix)(
    "syncs the new content to disk before it replaces the file, then syncs the folder",
    () => {
      // given
      const file = join(dir, "state.json");
      writeFileSync(file, "old");

      // when
      writeFileAtomic(file, "new");

      // then
      expect(steps).toEqual(["sync", "rename", "sync folder"]);
      expect(readFileSync(file, "utf-8")).toBe("new");
      expect(readdirSync(dir)).toEqual(["state.json"]);
    },
  );

  it.skipIf(!canChmod)(
    "syncs a file it has to write in place because the folder is read-only",
    () => {
      // given
      const file = join(dir, "state.json");
      writeFileSync(file, "old", { mode: 0o600 });
      chmodSync(dir, 0o500);

      // when
      writeFileAtomic(file, "new");

      // then
      expect(steps).toEqual(["sync"]);
      expect(readFileSync(file, "utf-8")).toBe("new");
    },
  );

  it("keeps the old content and leaves no staging file when the disk can't sync", () => {
    // given
    const file = join(dir, "state.json");
    writeFileSync(file, "old");
    disk.fileSyncError = "EIO";

    // when
    const save = () => writeFileAtomic(file, "new");

    // then
    expect(save).toThrow("fsync EIO");
    expect(readFileSync(file, "utf-8")).toBe("old");
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  it("saves on a drive that can't sync files", () => {
    // given
    const file = join(dir, "state.json");
    disk.fileSyncError = "EINVAL";

    // when
    writeFileAtomic(file, "new");

    // then
    expect(readFileSync(file, "utf-8")).toBe("new");
  });
});
