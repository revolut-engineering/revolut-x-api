import { existsSync } from "node:fs";
import type { KeyObject } from "node:crypto";
import { loadPrivateKey } from "./keypair.js";
import {
  loadConfig,
  getPrivateKeyFile,
  assertSecurePermissions,
} from "../config/settings.js";

export interface Credentials {
  apiKey: string;
  privateKey: KeyObject;
}

export function loadCredentials(): Credentials | null {
  const config = loadConfig();
  if (!config.api_key) return null;

  let keyPath = config.private_key_path || getPrivateKeyFile();
  if (!existsSync(keyPath)) {
    keyPath = getPrivateKeyFile();
  }
  if (!existsSync(keyPath)) return null;

  assertSecurePermissions(keyPath, "private key");

  try {
    const privateKey = loadPrivateKey(keyPath);
    return { apiKey: config.api_key, privateKey };
  } catch {
    return null;
  }
}
