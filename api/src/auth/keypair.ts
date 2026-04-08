import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export function generateKeypair(
  privateKeyPath: string,
  publicKeyPath: string,
): string {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });
  writeFileSync(publicKeyPath, publicKey, { mode: 0o600 });

  return publicKey;
}

export function loadPrivateKey(path: string): KeyObject {
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
