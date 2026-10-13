import { createPrivateKey, type KeyObject } from "node:crypto";
import type { CredentialsIssue } from "../http/errors.js";
import {
  getConfigFile,
  getPrivateKeyFile,
  describeCredentialsIssue,
  isMissing,
  isSettingsObject,
  parseConfigText,
  readSecureFile,
} from "../config/settings.js";

export interface Credentials {
  apiKey: string;
  privateKey: KeyObject;
  privateKeyPath?: string;
}

export type InvalidCredentials = { status: "invalid"; issue: CredentialsIssue };

export type CredentialsCheck =
  | { status: "ready"; credentials: Credentials }
  | { status: "missing"; missing: "api_key" }
  | InvalidCredentials;

export type PrivateKeyCheck =
  | { status: "ready"; privateKey: KeyObject }
  | InvalidCredentials;

type Checked<T> = { value: T } | { failure: InvalidCredentials };

const API_KEY_FORMAT = /^[A-Za-z0-9]{64}$/;

function invalid(
  file: CredentialsIssue["file"],
  fault: CredentialsIssue["fault"],
  path: string,
  reason: string,
): InvalidCredentials {
  return {
    status: "invalid",
    issue: describeCredentialsIssue(file, fault, path, reason),
  };
}

function readChecked(
  path: string,
  file: CredentialsIssue["file"],
): Checked<string> {
  const read = readSecureFile(path, file);
  if ("issue" in read) {
    return { failure: { status: "invalid", issue: read.issue } };
  }
  return { value: read.text };
}

function readConfig(path: string): Checked<Record<string, unknown>> {
  const text = readChecked(path, "config");
  if ("failure" in text) return text;
  let parsed: unknown;
  try {
    parsed = parseConfigText(text.value);
  } catch {
    return {
      failure: invalid("config", "malformed", path, "is not valid JSON"),
    };
  }
  if (!isSettingsObject(parsed)) {
    return {
      failure: invalid("config", "malformed", path, "is not a settings object"),
    };
  }
  return { value: parsed };
}

function keyFormatProblem(pem: string): string | null {
  if (pem.trim() === "") return "is empty";
  if (
    /-----BEGIN ENCRYPTED PRIVATE KEY-----|Proc-Type: 4,ENCRYPTED/.test(pem)
  ) {
    return "is protected by a passphrase, which is not supported";
  }
  if (pem.includes("-----BEGIN OPENSSH PRIVATE KEY-----")) {
    return "is in OpenSSH format. A PEM (PKCS #8) Ed25519 key is needed";
  }
  if (pem.includes("-----BEGIN PUBLIC KEY-----") && !/PRIVATE KEY/.test(pem)) {
    return "holds a public key, not the private key";
  }
  return null;
}

export function inspectPrivateKey(path: string): PrivateKeyCheck {
  if (isMissing(path)) {
    return invalid("private_key", "missing", path, "is missing");
  }
  const pem = readChecked(path, "private_key");
  if ("failure" in pem) return pem.failure;
  const formatProblem = keyFormatProblem(pem.value);
  if (formatProblem) {
    return invalid("private_key", "malformed", path, formatProblem);
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem.value);
  } catch {
    return invalid(
      "private_key",
      "malformed",
      path,
      "is not a valid PEM private key",
    );
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    return invalid(
      "private_key",
      "malformed",
      path,
      `is not an Ed25519 key (found ${privateKey.asymmetricKeyType ?? "an unknown type"})`,
    );
  }
  return { status: "ready", privateKey };
}

export function resolvePrivateKeyFile(configuredPath?: string): string {
  const defaultPath = getPrivateKeyFile();
  if (!configuredPath) return defaultPath;
  if (!isMissing(configuredPath) || isMissing(defaultPath)) {
    return configuredPath;
  }
  return defaultPath;
}

export function inspectCredentials(): CredentialsCheck {
  const configFile = getConfigFile();
  if (isMissing(configFile)) return { status: "missing", missing: "api_key" };
  const config = readConfig(configFile);
  if ("failure" in config) return config.failure;

  const { api_key: rawApiKey, private_key_path: keyPath } = config.value;
  const apiKey = typeof rawApiKey === "string" ? rawApiKey.trim() : rawApiKey;
  if (apiKey === undefined || apiKey === "") {
    return { status: "missing", missing: "api_key" };
  }
  if (typeof apiKey !== "string" || !API_KEY_FORMAT.test(apiKey)) {
    return invalid(
      "config",
      "malformed",
      configFile,
      "has an API key that is not 64 letters and digits",
    );
  }
  if (keyPath !== undefined && typeof keyPath !== "string") {
    return invalid(
      "config",
      "malformed",
      configFile,
      "has a private_key_path that is not text",
    );
  }

  const privateKeyPath = resolvePrivateKeyFile(keyPath);
  const key = inspectPrivateKey(privateKeyPath);
  if (key.status === "invalid") return key;
  return {
    status: "ready",
    credentials: { apiKey, privateKey: key.privateKey, privateKeyPath },
  };
}

export function loadCredentials(): Credentials | null {
  const check = inspectCredentials();
  return check.status === "ready" ? check.credentials : null;
}
