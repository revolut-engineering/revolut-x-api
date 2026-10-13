import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  chmodSync,
  statSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  InsecureKeyPermissionsError,
  InvalidCredentialsError,
  type CredentialsIssue,
} from "../http/errors.js";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 3;

export interface RevolutXConfig {
  api_key?: string;
  private_key_path?: string;
}

function defaultConfigDir(): string {
  const p = platform();
  if (p === "win32") {
    return join(process.env["APPDATA"] ?? homedir(), "revolut-x");
  }
  return join(homedir(), ".config", "revolut-x");
}

export function setPermissions(path: string, mode: number): void {
  if (platform() === "win32") return;
  try {
    chmodSync(path, mode);
  } catch {}
}

export function redactHome(path: string): string {
  const home = homedir();
  if (home && (path === home || path.startsWith(home + "/"))) {
    return "~" + path.slice(home.length);
  }
  return path;
}

export function assertSecurePermissions(path: string, label: string): void {
  if (platform() === "win32") return;
  if (!existsSync(path)) return;
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    const display = redactHome(path);
    throw new InsecureKeyPermissionsError(
      `Refusing to load ${label} at ${display}: insecure permissions ` +
        `(0o${mode.toString(8).padStart(3, "0")}). ` +
        `Fix with: chmod 600 ${display}`,
      path,
    );
  }
}

export function assertKeyStillSecure(path: string, label: string): void {
  if (platform() === "win32") return;
  const display = redactHome(path);
  let mode: number;
  try {
    mode = statSync(path).mode & 0o777;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const reason =
      code === "ENOENT"
        ? "file is missing"
        : `cannot stat file (${code ?? "unknown error"})`;
    throw new InsecureKeyPermissionsError(
      `Refusing to sign with ${label} at ${display}: ${reason}. ` +
        `Restore the file with secure permissions and restart the process.`,
      path,
    );
  }
  if ((mode & 0o077) !== 0) {
    throw new InsecureKeyPermissionsError(
      `Refusing to sign with ${label} at ${display}: insecure permissions ` +
        `(0o${mode.toString(8).padStart(3, "0")}). ` +
        `Fix with: chmod 600 ${display}`,
      path,
    );
  }
}

export function getConfigDir(): string {
  const raw = process.env["REVOLUTX_CONFIG_DIR"] || defaultConfigDir();
  return resolve(raw.replace(/^~/, homedir()));
}

export function getConfigFile(): string {
  return join(getConfigDir(), "config.json");
}

export function getPrivateKeyFile(): string {
  return join(getConfigDir(), "private.pem");
}

export function getPublicKeyFile(): string {
  return join(getConfigDir(), "public.pem");
}

export function ensureConfigDir(): void {
  const dir = getConfigDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new Error(
      `Can't create the config folder ${redactHome(dir)} (${(err as NodeJS.ErrnoException).code ?? "error"}). Make sure the folders above it belong to you and you can write to them.`,
      { cause: err },
    );
  }
  setPermissions(dir, 0o700);
}

export function parseConfigText(text: string): unknown {
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

export function isSettingsObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function describeCredentialsIssue(
  file: CredentialsIssue["file"],
  fault: CredentialsIssue["fault"],
  path: string,
  reason: string,
  code?: string,
): CredentialsIssue {
  const subject = file === "config" ? "The config file" : "The private key";
  return {
    file,
    fault,
    path,
    problem: `${subject} ${redactHome(path)} ${reason}.`,
    ...(code ? { code } : {}),
  };
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "read error";
}

export function readSecureFile(
  path: string,
  file: CredentialsIssue["file"],
): { text: string } | { issue: CredentialsIssue } {
  let isFile: boolean;
  try {
    isFile = statSync(path).isFile();
  } catch (err) {
    return {
      issue: describeCredentialsIssue(
        file,
        "unreadable",
        path,
        `can't be read (${errorCode(err)})`,
        errorCode(err),
      ),
    };
  }
  if (!isFile) {
    return {
      issue: describeCredentialsIssue(
        file,
        "not_a_file",
        path,
        "is not a file",
      ),
    };
  }
  assertSecurePermissions(
    path,
    file === "config" ? "config file" : "private key",
  );
  try {
    return { text: readFileSync(path, "utf-8") };
  } catch (err) {
    return {
      issue: describeCredentialsIssue(
        file,
        "unreadable",
        path,
        `can't be read (${errorCode(err)})`,
        errorCode(err),
      ),
    };
  }
}

export function isMissing(path: string): boolean {
  try {
    statSync(path);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

export function loadConfig(): RevolutXConfig {
  const configFile = getConfigFile();
  if (isMissing(configFile)) {
    return {};
  }
  const read = readSecureFile(configFile, "config");
  if ("issue" in read) throw new InvalidCredentialsError(read.issue);
  let parsed: unknown;
  try {
    parsed = parseConfigText(read.text);
  } catch {
    return {};
  }
  if (!isSettingsObject(parsed)) return {};
  return {
    ...parsed,
    api_key: textOrUndefined(parsed.api_key),
    private_key_path: textOrUndefined(parsed.private_key_path),
  };
}

const MAX_LINK_HOPS = 40;

function writeTarget(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    let current = path;
    for (let hop = 0; hop < MAX_LINK_HOPS; hop++) {
      let link: string;
      try {
        link = readlinkSync(current);
      } catch {
        return current;
      }
      let folder = dirname(current);
      try {
        folder = realpathSync(folder);
      } catch {
        folder = dirname(current);
      }
      current = resolve(folder, link);
    }
    return current;
  }
}

export function writeFileAtomic(
  path: string,
  content: string,
  mode = 0o600,
): void {
  const target = writeTarget(path);
  const staging = `${target}.${randomUUID()}.tmp`;
  let stagingFd: number;
  try {
    stagingFd = openSync(staging, "wx", mode);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `Can't save ${redactHome(path)}: the folder ${redactHome(dirname(target))} does not exist.`,
        { cause: err },
      );
    }
    const folderLocked =
      code === "EACCES" || code === "EPERM" || code === "EROFS";
    if (!folderLocked) throw err;
    if (isMissing(target)) {
      throw new Error(
        `Can't save ${redactHome(path)}: the folder ${redactHome(dirname(target))} can't be written to (${code}).`,
        { cause: err },
      );
    }
    try {
      writeAndSync(openSync(target, "w", mode), content, mode);
    } catch (inPlace) {
      throw new Error(
        `Can't save ${redactHome(path)} (${(inPlace as NodeJS.ErrnoException).code ?? code}).`,
        { cause: inPlace },
      );
    }
    return;
  }
  try {
    writeAndSync(stagingFd, content, mode);
    renameSync(staging, target);
  } catch (err) {
    rmSync(staging, { force: true });
    throw err;
  }
  syncFolder(dirname(target));
}

const UNSYNCABLE_FILE_CODES = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP"]);

function writeAndSync(fd: number, content: string, mode: number): void {
  try {
    writeFileSync(fd, content);
    setDescriptorPermissions(fd, mode);
    syncFile(fd);
  } finally {
    closeSync(fd);
  }
}

function setDescriptorPermissions(fd: number, mode: number): void {
  if (platform() === "win32") return;
  try {
    fchmodSync(fd, mode);
  } catch {}
}

function syncFile(fd: number): void {
  try {
    fsyncSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!code || !UNSYNCABLE_FILE_CODES.has(code)) throw err;
  }
}

function syncFolder(folder: string): void {
  try {
    const fd = openSync(folder, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    return;
  }
}

export function saveConfig(config: RevolutXConfig): void {
  ensureConfigDir();
  writeFileAtomic(getConfigFile(), JSON.stringify(config, null, 2));
}

export function isConfigured(): boolean {
  let config: RevolutXConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof InvalidCredentialsError) return false;
    throw err;
  }
  if (!config.api_key) return false;
  const keyPath = config.private_key_path || getPrivateKeyFile();
  return existsSync(keyPath);
}
