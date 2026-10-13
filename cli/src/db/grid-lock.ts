import {
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname, uptime } from "node:os";
import { basename, dirname, join } from "node:path";
import { ensureConfigDir } from "@revolut/revolut-x-api";
import { gridLockFilePath } from "./grid-store.js";

interface GridLockOwner {
  pid: number;
  host: string;
  startedAt: string;
  uptime?: number;
  bootId?: string;
}

export interface GridLock {
  release(): void;
}

interface TakeoverGuard extends GridLock {
  outlived(): boolean;
}

export class GridAlreadyRunningError extends Error {
  constructor(pair: string, owner: GridLockOwner, lockPath: string) {
    const started = new Date(owner.startedAt).toLocaleString();
    super(
      owner.host === hostname()
        ? `Grid ${pair} is already running (process ${owner.pid}, started ${started}). Stop it first. If no grid is running, delete ${lockPath}.`
        : `Grid ${pair} is already running on ${owner.host} (process ${owner.pid}, started ${started}). Stop it there first. If no grid is running there, delete ${lockPath}.`,
    );
    this.name = "GridAlreadyRunningError";
  }
}

const ACQUIRE_ATTEMPTS = 5;
const STARTING_LOCK_MS = 5_000;
const GUARD_LEASE_MS = 5_000;
const GUARD_ABANDONED_MS = 10_000;
const CLOCK_TOLERANCE_MS = 2_000;
const REBOOT_MARGIN_SEC = 5;
const BOOT_ID_FILE = "/proc/sys/kernel/random/boot_id";
const TAKEOVER_BACKOFF_MS = 50;
const GUARD_TAKEN = new Set([
  "EBUSY",
  "ENOENT",
  "EEXIST",
  "ENOTEMPTY",
  "ENOTDIR",
  "EISDIR",
  "EPERM",
  "EACCES",
]);
const NO_HARD_LINKS = new Set([
  "EPERM",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EXDEV",
  "ENOSYS",
]);

export async function acquireGridLock(pair: string): Promise<GridLock> {
  ensureConfigDir();
  const lockPath = gridLockFilePath(pair);
  const content = JSON.stringify({
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    uptime: uptime(),
    bootId: currentBootId(),
  } satisfies GridLockOwner);
  sweepLeftovers(lockPath);
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
    if (createExclusively(lockPath, content)) {
      return { release: () => removeIfHeld(lockPath, content) };
    }
    const held = readLock(lockPath);
    if (held === null) continue;
    const owner = parseOwner(held);
    if (owner === null && isFresh(lockPath)) {
      throw new Error(
        `Another grid run is starting for ${pair} (lock ${lockPath}). Try again in a few seconds.`,
      );
    }
    if (owner && isRunning(owner)) {
      throw new GridAlreadyRunningError(pair, owner, lockPath);
    }
    if (takeOver(lockPath, held, content)) {
      return { release: () => removeIfHeld(lockPath, content) };
    }
    await new Promise((resolve) =>
      setTimeout(resolve, TAKEOVER_BACKOFF_MS * (attempt + 1)),
    );
  }
  throw new Error(
    `Another grid run is taking over the grid lock ${lockPath}. Try again in a few seconds.`,
  );
}

function takeOver(lockPath: string, stale: string, content: string): boolean {
  const guardPath = `${lockPath}.takeover`;
  const guard = takeGuard(guardPath, content);
  if (!guard) {
    clearAbandonedGuard(guardPath);
    return false;
  }
  try {
    if (readLock(lockPath) !== stale) return false;
    if (parseOwner(stale) === null && isFresh(lockPath)) return false;
    if (guard.outlived()) return false;
    rmSync(lockPath, { force: true });
    return createExclusively(lockPath, content);
  } finally {
    guard.release();
  }
}

function takeGuard(guardPath: string, content: string): TakeoverGuard | null {
  const staging = `${guardPath}.${randomUUID()}.tmp`;
  const ownerFile = `owner-${randomUUID()}`;
  try {
    mkdirSync(staging, { mode: 0o700 });
    writeFileSync(join(staging, ownerFile), content, { mode: 0o600 });
  } catch (err) {
    bestEffortRemove(staging);
    throw err;
  }
  try {
    renameSync(staging, guardPath);
  } catch (err) {
    bestEffortRemove(staging);
    const code = errorCode(err);
    if (code && GUARD_TAKEN.has(code)) return null;
    throw err;
  }
  return {
    release: () => releaseGuard(guardPath, ownerFile),
    outlived: () => {
      const age = ageMs(join(guardPath, ownerFile));
      return (
        age === null || age <= -CLOCK_TOLERANCE_MS || age >= GUARD_LEASE_MS
      );
    },
  };
}

function releaseGuard(guardPath: string, ownerFile: string): void {
  try {
    rmSync(join(guardPath, ownerFile));
    rmdirSync(guardPath);
  } catch {
    return;
  }
}

function clearAbandonedGuard(guardPath: string): void {
  let entries: string[];
  try {
    entries = readdirSync(guardPath);
  } catch (err) {
    const code = errorCode(err);
    if (code === "ENOTDIR" && isAbandoned(guardPath)) {
      try {
        rmSync(guardPath, { force: true });
      } catch {
        return;
      }
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(
        `The grid lock guard ${guardPath} can't be read (${code}). It may belong to another user who started this grid.`,
      );
    }
    return;
  }
  if (entries.length === 0) {
    try {
      rmdirSync(guardPath);
    } catch {
      return;
    }
    return;
  }
  for (const entry of entries) {
    if (isAbandoned(join(guardPath, entry))) releaseGuard(guardPath, entry);
  }
}

function sweepLeftovers(lockPath: string): void {
  const folder = dirname(lockPath);
  const prefix = `${basename(lockPath)}.`;
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(folder, name);
    if (name.startsWith(prefix) && name.endsWith(".tmp") && isAbandoned(path)) {
      bestEffortRemove(path);
    }
  }
}

function createExclusively(path: string, content: string): boolean {
  const staging = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(staging, content, { mode: 0o600 });
    linkSync(staging, path);
    return true;
  } catch (err) {
    const code = errorCode(err);
    if (code === "EEXIST") return false;
    if (code && NO_HARD_LINKS.has(code))
      return createWithoutLink(path, content);
    throw err;
  } finally {
    bestEffortRemove(staging);
  }
}

function createWithoutLink(path: string, content: string): boolean {
  try {
    writeFileSync(path, content, { flag: "wx", mode: 0o600 });
    return true;
  } catch (err) {
    if (errorCode(err) === "EEXIST") return false;
    throw err;
  }
}

function readLock(lockPath: string): string | null {
  try {
    return readFileSync(lockPath, "utf-8");
  } catch (err) {
    const code = errorCode(err);
    if (code === "ENOENT") return null;
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(
        `The grid lock ${lockPath} can't be read (${code}). It may belong to another user who started this grid.`,
      );
    }
    throw err;
  }
}

function ageMs(path: string): number | null {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function isFresh(path: string): boolean {
  const age = ageMs(path);
  return age !== null && age > -CLOCK_TOLERANCE_MS && age < STARTING_LOCK_MS;
}

function isAbandoned(path: string): boolean {
  const age = ageMs(path);
  return (
    age !== null && (age <= -CLOCK_TOLERANCE_MS || age >= GUARD_ABANDONED_MS)
  );
}

function removeIfHeld(path: string, content: string): void {
  try {
    if (readLock(path) === content) rmSync(path, { force: true });
  } catch {
    return;
  }
}

function bestEffortRemove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    return;
  }
}

function parseOwner(text: string): GridLockOwner | null {
  try {
    const owner = JSON.parse(text) as Partial<GridLockOwner>;
    if (
      Number.isInteger(owner.pid) &&
      owner.pid! > 0 &&
      typeof owner.host === "string" &&
      typeof owner.startedAt === "string" &&
      Number.isFinite(Date.parse(owner.startedAt))
    ) {
      return {
        ...(owner as GridLockOwner),
        bootId: typeof owner.bootId === "string" ? owner.bootId : undefined,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function isRunning(owner: GridLockOwner): boolean {
  if (owner.host !== hostname()) return true;
  if (owner.pid === process.pid) return false;
  if (restartedSince(owner)) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (err) {
    return errorCode(err) === "EPERM";
  }
}

function restartedSince(owner: GridLockOwner): boolean {
  const bootId = currentBootId();
  const bootChanged = !!bootId && !!owner.bootId && bootId !== owner.bootId;
  const uptimeWentBack =
    typeof owner.uptime === "number" &&
    uptime() + REBOOT_MARGIN_SEC < owner.uptime;
  return bootChanged || uptimeWentBack;
}

function currentBootId(): string | undefined {
  try {
    return readFileSync(BOOT_ID_FILE, "utf-8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}
