import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "api-k9x2a";

function getPasskeyFile(): string {
  return join(getConfigDir(), "passkey");
}

export function hasPasskey(): boolean {
  return existsSync(getPasskeyFile());
}

export function setPasskey(passkey: string): void {
  const salt = randomBytes(32).toString("hex");
  const hash = scryptSync(passkey, salt, 64).toString("hex");
  writeFileSync(getPasskeyFile(), `scrypt:${salt}:${hash}`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

export function verifyPasskey(passkey: string): boolean {
  if (!hasPasskey()) return false;
  const contents = readFileSync(getPasskeyFile(), "utf-8").trim();
  const parts = contents.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, storedHash] = parts;
  try {
    const hash = scryptSync(passkey, salt, 64);
    const stored = Buffer.from(storedHash, "hex");
    if (hash.length !== stored.length) return false;
    return timingSafeEqual(hash, stored);
  } catch {
    return false;
  }
}

export function getPasskeyFileHash(): string {
  const contents = readFileSync(getPasskeyFile(), "utf-8").trim();
  return createHash("sha256").update(contents).digest("hex");
}

export function removePasskey(): void {
  const file = getPasskeyFile();
  if (!existsSync(file)) return;
  // Overwrite with zeros before unlinking so the hash isn't recoverable
  try {
    const { size } = statSync(file);
    const fd = openSync(file, "r+");
    try {
      writeSync(fd, Buffer.alloc(size, 0), 0, size, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    // best-effort secure erase
  }
  unlinkSync(file);
}
