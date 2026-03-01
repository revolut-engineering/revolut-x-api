import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  generateEd25519Keypair,
  loadPrivateKey,
  getPublicKeyPem,
} from "../../src/shared/auth/keypair.js";
import { existsSync } from "node:fs";

describe("keypair", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "revolutx-keypair-"));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("generateEd25519Keypair creates files and returns public key PEM", () => {
    const privPath = join(tmpDir, "private.pem");
    const pubPath = join(tmpDir, "public.pem");

    const pubPem = generateEd25519Keypair(privPath, pubPath);

    expect(existsSync(privPath)).toBe(true);
    expect(existsSync(pubPath)).toBe(true);
    expect(pubPem).toContain("BEGIN PUBLIC KEY");
    expect(pubPem).toContain("END PUBLIC KEY");
  });

  it("loadPrivateKey returns a valid Ed25519 key", () => {
    const privPath = join(tmpDir, "private.pem");
    const pubPath = join(tmpDir, "public.pem");

    generateEd25519Keypair(privPath, pubPath);
    const key = loadPrivateKey(privPath);

    expect(key.asymmetricKeyType).toBe("ed25519");
  });

  it("roundtrip: getPublicKeyPem matches generated public key", () => {
    const privPath = join(tmpDir, "private.pem");
    const pubPath = join(tmpDir, "public.pem");

    const originalPub = generateEd25519Keypair(privPath, pubPath);
    const key = loadPrivateKey(privPath);
    const reloadedPub = getPublicKeyPem(key);

    expect(originalPub).toBe(reloadedPub);
  });
});
