import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { RevolutXConfigSchema, type RevolutXConfig } from "./models/config.js";

function defaultConfigDir(): string {
  const p = platform();
  if (p === "win32") {
    return join(process.env["APPDATA"] ?? homedir(), "revolutx-mcp");
  }
  if (p === "darwin") {
    return join(homedir(), "Library", "Application Support", "revolutx-mcp");
  }
  return join(homedir(), ".config", "revolutx-mcp");
}

function setPermissions(path: string, mode: number): void {
  if (platform() === "win32") return;
  try {
    chmodSync(path, mode);
  } catch {
    // silently ignore permission errors
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
    return RevolutXConfigSchema.parse({});
  }
  try {
    const data = JSON.parse(readFileSync(configFile, "utf-8"));
    return RevolutXConfigSchema.parse(data);
  } catch {
    return RevolutXConfigSchema.parse({});
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

  let keyPath = config.private_key_path || getPrivateKeyFile();
  if (!existsSync(keyPath)) {
    keyPath = getPrivateKeyFile();
  }
  return existsSync(keyPath);
}

export function setFilePermissions600(path: string): void {
  setPermissions(path, 0o600);
}
