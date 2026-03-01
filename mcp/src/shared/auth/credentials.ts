import { existsSync } from "node:fs";
import type { KeyObject } from "node:crypto";
import { loadPrivateKey } from "./keypair.js";
import { getPrivateKeyFile, loadConfig } from "../settings.js";
import { AuthNotConfiguredError } from "../client/exceptions.js";

export const SETUP_GUIDE =
  "Revolut X API is not configured yet. Follow these steps:\n\n" +
  "1. Run the 'generate_keypair' tool to create your authentication keys\n" +
  "2. Copy the public key that is returned\n" +
  "3. Go to your Revolut X account → Profile → API Keys\n" +
  "4. Add the public key and get your API key\n" +
  "5. Run the 'configure_api_key' tool with your API key\n" +
  "6. Run 'check_auth_status' to verify everything works";

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

  try {
    const privateKey = loadPrivateKey(keyPath);
    return { apiKey: config.api_key, privateKey };
  } catch {
    return null;
  }
}

export function requireCredentials(): Credentials {
  const creds = loadCredentials();
  if (creds === null) {
    throw new AuthNotConfiguredError(SETUP_GUIDE);
  }
  return creds;
}
