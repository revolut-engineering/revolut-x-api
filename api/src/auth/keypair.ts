import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  assertSecurePermissions,
  getPrivateKeyFile,
  getPublicKeyFile,
  setPermissions,
  writeFileAtomic,
} from "../config/settings.js";

export function generateKeypair(
  privateKeyPath: string,
  publicKeyPath: string,
): string {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  writeFileAtomic(privateKeyPath, privateKey);
  writeFileAtomic(publicKeyPath, publicKey);

  return publicKey;
}

function samePath(a: string, b: string): boolean {
  try {
    const first = statSync(a);
    const second = statSync(b);
    return first.dev === second.dev && first.ino === second.ino;
  } catch {
    try {
      return (
        basename(a) === basename(b) &&
        realpathSync(dirname(a)) === realpathSync(dirname(b))
      );
    } catch {
      return resolve(a) === resolve(b);
    }
  }
}

export function publicKeyFileFor(privateKeyPath: string): string {
  if (samePath(privateKeyPath, getPrivateKeyFile())) return getPublicKeyFile();
  return `${privateKeyPath.replace(/\.pem$/i, "")}.public.pem`;
}

export function moveKeypairAside(
  privateKeyPath: string,
  publicKeyPath: string,
): string {
  const suffix = `.replaced-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const movedPrivateKey = `${privateKeyPath}${suffix}`;
  const movedPublicKey = `${publicKeyPath}${suffix}`;
  if (existsSync(movedPrivateKey) || existsSync(movedPublicKey)) {
    throw new Error(
      `Could not move the key aside: ${movedPrivateKey} already exists. Try again.`,
    );
  }
  renameSync(privateKeyPath, movedPrivateKey);
  setPermissions(movedPrivateKey, 0o600);
  if (existsSync(publicKeyPath)) renameSync(publicKeyPath, movedPublicKey);
  return movedPrivateKey;
}

export function loadPrivateKey(path: string): KeyObject {
  assertSecurePermissions(path, "private key");
  const pem = readFileSync(path, "utf-8");
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `Expected Ed25519 private key, got ${key.asymmetricKeyType}`,
    );
  }
  return key;
}

export function getPublicKeyPem(privateKey: KeyObject): string {
  const publicKey = createPublicKey(privateKey);
  return publicKey.export({ type: "spki", format: "pem" }) as string;
}
