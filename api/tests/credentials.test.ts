import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCredentials } from "../src/auth/credentials.js";
import { saveConfig } from "../src/config/settings.js";
import { generateKeypair } from "../src/auth/keypair.js";

describe("loadCredentials", () => {
  let dir: string;
  const origEnv = process.env["REVOLUTX_CONFIG_DIR"];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "revx-creds-"));
    process.env["REVOLUTX_CONFIG_DIR"] = dir;
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env["REVOLUTX_CONFIG_DIR"];
    else process.env["REVOLUTX_CONFIG_DIR"] = origEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when no api key is configured", () => {
    expect(loadCredentials()).toBeNull();
  });

  it("returns null when the api key is set but no key file exists", () => {
    saveConfig({ api_key: "a".repeat(64) });
    expect(loadCredentials()).toBeNull();
  });

  it("returns credentials when configured correctly", () => {
    const privPath = join(dir, "private.pem");
    const pubPath = join(dir, "public.pem");
    generateKeypair(privPath, pubPath);
    saveConfig({ api_key: "a".repeat(64), private_key_path: privPath });

    const creds = loadCredentials();
    expect(creds).not.toBeNull();
    expect(creds?.apiKey).toBe("a".repeat(64));
    expect(creds?.privateKeyPath).toBe(privPath);
  });

  it("throws instead of silently returning null when the key file is corrupted", () => {
    const privPath = join(dir, "private.pem");
    writeFileSync(privPath, "not a real pem", { mode: 0o600 });
    saveConfig({ api_key: "a".repeat(64), private_key_path: privPath });

    expect(() => loadCredentials()).toThrow();
  });
});
