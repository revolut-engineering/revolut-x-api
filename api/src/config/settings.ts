import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  statSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

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

export function assertSecurePermissions(path: string, label: string): void {
  if (platform() === "win32") return;
  if (!existsSync(path)) return;
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `Refusing to load ${label} at ${path}: insecure permissions ` +
        `(0o${mode.toString(8).padStart(3, "0")}). ` +
        `Fix with: chmod 600 ${path}`,
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
  mkdirSync(dir, { recursive: true });
  setPermissions(dir, 0o700);
}

export function loadConfig(): RevolutXConfig {
  const configFile = getConfigFile();
  if (!existsSync(configFile)) {
    return {};
  }
  assertSecurePermissions(configFile, "config file");
  try {
    return JSON.parse(readFileSync(configFile, "utf-8")) as RevolutXConfig;
  } catch {
    return {};
  }
}

export function saveConfig(config: RevolutXConfig): void {
  ensureConfigDir();
  const configFile = getConfigFile();
  writeFileSync(configFile, JSON.stringify(config, null, 2), "utf-8");
  setPermissions(configFile, 0o600);
}

export function isConfigured(): boolean {
  const config = loadConfig();
  if (!config.api_key) return false;
  const keyPath = config.private_key_path || getPrivateKeyFile();
  return existsSync(keyPath);
}
