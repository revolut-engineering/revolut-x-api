import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { hostname, tmpdir, uptime } from "node:os";
import { join, resolve } from "node:path";

const links = vi.hoisted(() => ({
  refuse: false,
  renames: 0,
  beforeRename: undefined as undefined | (() => void),
}));

const machine = vi.hoisted(() => ({
  bootId: undefined as string | undefined,
}));

const BOOT_ID_FILE = "/proc/sys/kernel/random/boot_id";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      if (args[0] !== BOOT_ID_FILE) return actual.readFileSync(...args);
      if (machine.bootId === undefined) {
        throw Object.assign(new Error("open ENOENT"), { code: "ENOENT" });
      }
      return `${machine.bootId}\n`;
    }) as typeof actual.readFileSync,
    linkSync: (...args: Parameters<typeof actual.linkSync>) => {
      if (links.refuse) {
        throw Object.assign(new Error("link EPERM"), { code: "EPERM" });
      }
      return actual.linkSync(...args);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      links.renames++;
      const hook = links.beforeRename;
      links.beforeRename = undefined;
      hook?.();
      return actual.renameSync(...args);
    },
  };
});

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "revx-grid-lock-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  links.refuse = false;
  links.renames = 0;
  links.beforeRename = undefined;
  machine.bootId = undefined;
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

const { acquireGridLock, GridAlreadyRunningError } =
  await import("../src/db/grid-lock.js");

const LOCK = "grid_state_BTC-USD.lock";
const canChmod =
  process.platform !== "win32" &&
  typeof process.getuid === "function" &&
  process.getuid() !== 0;

function lockPath(): string {
  return join(tempDir, LOCK);
}

function writeHolder(holder: Record<string, unknown> | string): void {
  writeFileSync(
    lockPath(),
    typeof holder === "string" ? holder : JSON.stringify(holder),
  );
}

function readHolder(): Record<string, unknown> {
  return JSON.parse(readFileSync(lockPath(), "utf-8"));
}

function makeOld(path: string, ageMs = 60_000): void {
  const then = new Date(Date.now() - ageMs);
  utimesSync(path, then, then);
}

function writeGuard(ageMs: number): string {
  const guard = `${lockPath()}.takeover`;
  mkdirSync(guard);
  const owner = join(guard, "owner-1");
  writeFileSync(owner, "");
  makeOld(owner, ageMs);
  return guard;
}

function processGone(): void {
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
  });
}

describe("grid lock", () => {
  it("records this process, its host and its start time", async () => {
    // when
    await acquireGridLock("BTC-USD");

    // then
    expect(readHolder()).toEqual({
      pid: process.pid,
      host: hostname(),
      startedAt: expect.any(String),
      uptime: expect.any(Number),
    });
    expect(readdirSync(tempDir)).toEqual([LOCK]);
  });

  it.skipIf(process.platform === "win32")(
    "creates the lock readable only by its owner",
    async () => {
      // when
      await acquireGridLock("BTC-USD");

      // then
      expect(statSync(lockPath()).mode & 0o777).toBe(0o600);
    },
  );

  it("refuses a second run while the first one's process is alive", async () => {
    // given
    const holder = {
      pid: process.ppid,
      host: hostname(),
      startedAt: new Date().toISOString(),
    };
    writeHolder(holder);

    // when
    const acquire = () => acquireGridLock("BTC-USD");

    // then
    await expect(acquire()).rejects.toThrow(GridAlreadyRunningError);
    await expect(acquire()).rejects.toThrow(
      new RegExp(
        `^Grid BTC-USD is already running \\(process ${process.ppid}, started .+\\)\\. Stop it first\\. If no grid is running, delete ${lockPath().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.$`,
      ),
    );
    expect(readHolder()).toEqual(holder);
  });

  it("treats a process it may not signal as alive", async () => {
    // given
    writeHolder({
      pid: 1,
      host: hostname(),
      startedAt: new Date().toISOString(),
    });
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    });

    // when
    const acquire = () => acquireGridLock("BTC-USD");

    // then
    await expect(acquire()).rejects.toThrow(GridAlreadyRunningError);
  });

  it("takes over a lock whose process is gone", async () => {
    // given
    writeHolder({
      pid: 999_999,
      host: hostname(),
      startedAt: new Date().toISOString(),
    });
    processGone();

    // when
    await acquireGridLock("BTC-USD");

    // then
    expect(readHolder()).toMatchObject({ pid: process.pid });
  });

  it("takes over a lock from before the machine restarted, whatever the clock says", async () => {
    // given
    writeHolder({
      pid: process.ppid,
      host: hostname(),
      startedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      uptime: uptime() + 3600,
    });

    // when
    await acquireGridLock("BTC-USD");

    // then
    expect(readHolder()).toMatchObject({ pid: process.pid });
  });

  it("records the machine's boot when the system reports one", async () => {
    // given
    machine.bootId = "boot-a";

    // when
    await acquireGridLock("BTC-USD");

    // then
    expect(readHolder()).toMatchObject({
      pid: process.pid,
      bootId: "boot-a",
    });
  });

  it("takes over a lock from an earlier boot even when the uptime doesn't show the restart", async () => {
    // given
    machine.bootId = "boot-b";
    writeHolder({
      pid: process.ppid,
      host: hostname(),
      startedAt: new Date().toISOString(),
      uptime: 0,
      bootId: "boot-a",
    });

    // when
    await acquireGridLock("BTC-USD");

    // then
    expect(readHolder()).toMatchObject({ pid: process.pid, bootId: "boot-b" });
  });

  it("keeps a lock from the same boot while its process runs", async () => {
    // given
    machine.bootId = "boot-a";
    writeHolder({
      pid: process.ppid,
      host: hostname(),
      startedAt: new Date().toISOString(),
      uptime: uptime(),
      bootId: "boot-a",
    });

    // then
    await expect(acquireGridLock("BTC-USD")).rejects.toThrow(
      GridAlreadyRunningError,
    );
  });

  it("takes over a lock from the same boot whose process is gone", async () => {
    // given
    machine.bootId = "boot-a";
    processGone();
    writeHolder({
      pid: 4242,
      host: hostname(),
      startedAt: new Date().toISOString(),
      uptime: uptime(),
      bootId: "boot-a",
    });

    // when
    await acquireGridLock("BTC-USD");

    // then
    expect(readHolder()).toMatchObject({ pid: process.pid });
  });

  it("takes over a lock whose uptime shows a restart even when the boot id is the same, as in a restarted container", async () => {
    // given
    machine.bootId = "boot-a";
    writeHolder({
      pid: process.ppid,
      host: hostname(),
      startedAt: new Date().toISOString(),
      uptime: uptime() + 3600,
      bootId: "boot-a",
    });

    // when
    await acquireGridLock("BTC-USD");

    // then
    expect(readHolder()).toMatchObject({ pid: process.pid });
  });

  it("keeps a lock from an older version without a boot id while its process runs", async () => {
    // given
    machine.bootId = "boot-a";
    writeHolder({
      pid: process.ppid,
      host: hostname(),
      startedAt: new Date().toISOString(),
      uptime: uptime(),
    });

    // then
    await expect(acquireGridLock("BTC-USD")).rejects.toThrow(
      GridAlreadyRunningError,
    );
  });

  it("ignores a boot id that isn't text", async () => {
    // given
    machine.bootId = "boot-a";
    writeHolder({
      pid: process.ppid,
      host: hostname(),
      startedAt: new Date().toISOString(),
      uptime: uptime(),
      bootId: 12345,
    });

    // then
    await expect(acquireGridLock("BTC-USD")).rejects.toThrow(
      GridAlreadyRunningError,
    );
  });

  it("records no boot when the system's boot id is empty", async () => {
    // given
    machine.bootId = "";

    // when
    await acquireGridLock("BTC-USD");

    // then
    expect(readHolder()).not.toHaveProperty("bootId");
  });

  it("keeps a live lock even when the clock jumped forward", async () => {
    // given
    writeHolder({
      pid: process.ppid,
      host: hostname(),
      startedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
      uptime: 0,
    });

    // then
    await expect(acquireGridLock("BTC-USD")).rejects.toThrow(
      GridAlreadyRunningError,
    );
  });

  it("takes over a lock that holds this process's own id", async () => {
    // given
    writeHolder({
      pid: process.pid,
      host: hostname(),
      startedAt: new Date().toISOString(),
    });

    // when
    const lock = await acquireGridLock("BTC-USD");

    // then
    expect(readHolder()).toMatchObject({
      pid: process.pid,
      uptime: expect.any(Number),
    });
    lock.release();
  });

  it("takes over an old lock that holds no readable owner", async () => {
    // given
    writeHolder("not a lock");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath(), old, old);

    // when
    await acquireGridLock("BTC-USD");

    // then
    expect(readHolder()).toMatchObject({ pid: process.pid });
  });

  it("waits for a lock that another run is still writing", async () => {
    // given
    writeHolder("");

    // then
    await expect(acquireGridLock("BTC-USD")).rejects.toThrow(
      `Another grid run is starting for BTC-USD (lock ${lockPath()}). Try again in a few seconds.`,
    );
  });

  it("treats a lock stamped a moment ahead of the clock as just written", async () => {
    // given
    writeHolder("");
    const moment = new Date(Date.now() + 500);
    utimesSync(lockPath(), moment, moment);

    // then
    await expect(acquireGridLock("BTC-USD")).rejects.toThrow(
      "Another grid run is starting",
    );
  });

  it("takes over an empty lock whose time is ahead of the clock", async () => {
    // given
    writeHolder("");
    const ahead = new Date(Date.now() + 2 * 60 * 60 * 1000);
    utimesSync(lockPath(), ahead, ahead);

    // when
    await acquireGridLock("BTC-USD");

    // then
    expect(readHolder()).toMatchObject({ pid: process.pid });
  });

  it("leaves an old empty lock that another run re-creates during the takeover", async () => {
    // given
    links.refuse = true;
    writeHolder("");
    makeOld(lockPath());
    links.beforeRename = () => {
      rmSync(lockPath());
      writeHolder("");
    };

    // when
    const attempt = acquireGridLock("BTC-USD");

    // then
    await expect(attempt).rejects.toThrow("Another grid run is starting");
    expect(readFileSync(lockPath(), "utf-8")).toBe("");
  });

  it("clears a takeover left by a crashed run and takes the lock", async () => {
    // given
    processGone();
    writeHolder({
      pid: 999_999,
      host: hostname(),
      startedAt: new Date().toISOString(),
    });
    writeGuard(60_000);

    // when
    await acquireGridLock("BTC-USD");

    // then
    expect(readHolder()).toMatchObject({ pid: process.pid });
    expect(readdirSync(tempDir)).toEqual([LOCK]);
  });

  it("clears a takeover whose time is ahead of the clock", async () => {
    // given
    processGone();
    writeHolder({
      pid: 999_999,
      host: hostname(),
      startedAt: new Date().toISOString(),
    });
    writeGuard(-2 * 60 * 60 * 1000);

    // when
    await acquireGridLock("BTC-USD");

    // then
    expect(readHolder()).toMatchObject({ pid: process.pid });
    expect(readdirSync(tempDir)).toEqual([LOCK]);
  });

  it("waits while another run is taking over the same stale lock", async () => {
    // given
    processGone();
    writeHolder({
      pid: 999_999,
      host: hostname(),
      startedAt: new Date().toISOString(),
    });
    const guard = writeGuard(0);

    // when
    const attempt = acquireGridLock("BTC-USD");

    // then
    await expect(attempt).rejects.toThrow(
      `Another grid run is taking over the grid lock ${lockPath()}. Try again in a few seconds.`,
    );
    expect(readdirSync(guard)).toEqual(["owner-1"]);
  });

  it.each([
    ["a moment ahead of the clock", -500],
    ["9 s old", 9_000],
  ])("keeps a takeover whose owner is %s", async (_name, ageMs) => {
    // given
    processGone();
    writeHolder({
      pid: 999_999,
      host: hostname(),
      startedAt: new Date().toISOString(),
    });
    const guard = writeGuard(ageMs);

    // then
    await expect(acquireGridLock("BTC-USD")).rejects.toThrow(
      "Another grid run is taking over the grid lock",
    );
    expect(readdirSync(guard)).toEqual(["owner-1"]);
  });

  it("removes a takeover file left by an older version, but not a fresh one", async () => {
    // given
    processGone();
    writeHolder({
      pid: 999_999,
      host: hostname(),
      startedAt: new Date().toISOString(),
    });
    const guard = `${lockPath()}.takeover`;
    writeFileSync(guard, "");

    // when
    const whileFresh = await acquireGridLock("BTC-USD").then(
      () => "taken",
      (err: Error) => err.message,
    );
    makeOld(guard);
    await acquireGridLock("BTC-USD");

    // then
    expect(whileFresh).toContain("Another grid run is taking over");
    expect(readHolder()).toMatchObject({ pid: process.pid });
    expect(existsSync(guard)).toBe(false);
  });

  it.skipIf(!canChmod)("names a takeover folder it can't read", async () => {
    // given
    processGone();
    writeHolder({
      pid: 999_999,
      host: hostname(),
      startedAt: new Date().toISOString(),
    });
    const guard = writeGuard(60_000);
    chmodSync(guard, 0o000);

    // when
    const attempt = acquireGridLock("BTC-USD");

    // then
    await expect(attempt).rejects.toThrow(
      `The grid lock guard ${guard} can't be read (EACCES).`,
    );
    chmodSync(guard, 0o700);
  });

  it("starts the takeover again when its own guard outlived its lease", async () => {
    // given
    processGone();
    writeHolder({
      pid: 999_999,
      host: hostname(),
      startedAt: new Date().toISOString(),
    });
    links.beforeRename = () => {
      const staging = readdirSync(tempDir).find((name) =>
        name.includes(".takeover."),
      )!;
      const owner = readdirSync(join(tempDir, staging))[0];
      makeOld(join(tempDir, staging, owner), 6_000);
    };

    // when
    await acquireGridLock("BTC-USD");

    // then
    expect(links.renames).toBe(2);
    expect(readHolder()).toMatchObject({ pid: process.pid });
  });

  it("sweeps old leftovers of interrupted runs and keeps fresh ones", async () => {
    // given
    const oldFile = join(tempDir, `${LOCK}.1111.tmp`);
    const oldFolder = join(tempDir, `${LOCK}.takeover.2222.tmp`);
    const freshFile = join(tempDir, `${LOCK}.3333.tmp`);
    writeFileSync(oldFile, "");
    mkdirSync(oldFolder);
    writeFileSync(join(oldFolder, "owner-x"), "");
    writeFileSync(freshFile, "");
    makeOld(oldFile);
    makeOld(oldFolder);

    // when
    const lock = await acquireGridLock("BTC-USD");

    // then
    expect(readdirSync(tempDir).sort()).toEqual(
      [LOCK, `${LOCK}.3333.tmp`].sort(),
    );
    lock.release();
  });

  it("keeps a lock whose machine reports a slightly lower uptime", async () => {
    // given
    writeHolder({
      pid: process.ppid,
      host: hostname(),
      startedAt: new Date().toISOString(),
      uptime: uptime() + 2,
    });

    // then
    await expect(acquireGridLock("BTC-USD")).rejects.toThrow(
      GridAlreadyRunningError,
    );
  });

  it.skipIf(!canChmod)("names a lock it can't read", async () => {
    // given
    writeHolder({ pid: process.ppid, host: hostname(), startedAt: "x" });
    chmodSync(lockPath(), 0o000);

    // then
    await expect(acquireGridLock("BTC-USD")).rejects.toThrow(
      `The grid lock ${lockPath()} can't be read (EACCES). It may belong to another user who started this grid.`,
    );
  });

  it("still locks on a folder that has no hard links", async () => {
    // given
    links.refuse = true;

    // when
    const lock = await acquireGridLock("BTC-USD");
    const created = readHolder();
    lock.release();
    writeHolder({
      pid: process.ppid,
      host: hostname(),
      startedAt: new Date().toISOString(),
    });

    // then
    expect(created).toMatchObject({ pid: process.pid });
    await expect(acquireGridLock("BTC-USD")).rejects.toThrow(
      GridAlreadyRunningError,
    );
  });

  it("refuses a lock taken on another machine and says where", async () => {
    // given
    writeHolder({
      pid: 4242,
      host: "other-host",
      startedAt: new Date().toISOString(),
    });
    processGone();

    // when
    const acquire = () => acquireGridLock("BTC-USD");

    // then
    await expect(acquire()).rejects.toThrow(
      /^Grid BTC-USD is already running on other-host \(process 4242, started .+\)\. Stop it there first\. If no grid is running there, delete .+grid_state_BTC-USD\.lock\.$/,
    );
  });

  it("lets grids on other pairs run at the same time", async () => {
    // given
    await acquireGridLock("BTC-USD");

    // when
    await acquireGridLock("ETH-USD");

    // then
    expect(readdirSync(tempDir).sort()).toEqual([
      "grid_state_BTC-USD.lock",
      "grid_state_ETH-USD.lock",
    ]);
  });

  it("removes its own lock on release", async () => {
    // given
    const lock = await acquireGridLock("BTC-USD");

    // when
    lock.release();
    lock.release();

    // then
    expect(existsSync(lockPath())).toBe(false);
  });

  it("leaves a lock that another run took over in the meantime", async () => {
    // given
    const lock = await acquireGridLock("BTC-USD");
    const other = {
      pid: process.ppid,
      host: hostname(),
      startedAt: new Date().toISOString(),
    };
    writeHolder(other);

    // when
    lock.release();

    // then
    expect(readHolder()).toEqual(other);
  });

  it("is refused by a second process while held, and taken over once that process is killed", async () => {
    // given
    const script = join(tempDir, "hold-lock.mts");
    writeFileSync(
      script,
      `import { acquireGridLock } from ${JSON.stringify(resolve("src/db/grid-lock.ts"))};
await acquireGridLock("BTC-USD");
console.log("held");
setInterval(() => {}, 1000);
`,
    );
    const child = spawn(process.execPath, ["--import", "tsx", script], {
      env: { ...process.env, REVOLUTX_CONFIG_DIR: tempDir },
    });
    await new Promise<void>((resolveHeld, reject) => {
      child.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("held")) resolveHeld();
      });
      child.on("exit", (code) => reject(new Error(`child exited ${code}`)));
    });

    // when
    const refused = await acquireGridLock("BTC-USD").then(
      () => null,
      (err: unknown) => err,
    );
    child.kill("SIGKILL");
    await new Promise((done) => child.on("exit", done));
    await acquireGridLock("BTC-USD");

    // then
    expect(refused).toBeInstanceOf(GridAlreadyRunningError);
    expect(readHolder()).toMatchObject({ pid: process.pid });
  }, 20_000);
});
