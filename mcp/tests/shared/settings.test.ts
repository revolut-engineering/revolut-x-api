import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import {
  getConfigDir,
  getConfigFile,
  getPrivateKeyFile,
  getPublicKeyFile,
  ensureConfigDir,
  loadConfig,
  saveConfig,
  isConfigured,
} from "../../src/shared/settings.js";

describe("settings", () => {
  let tmpDir: string;
  let origEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "revolutx-test-"));
    origEnv = process.env["REVOLUTX_CONFIG_DIR"];
    process.env["REVOLUTX_CONFIG_DIR"] = tmpDir;
  });

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env["REVOLUTX_CONFIG_DIR"];
    } else {
      process.env["REVOLUTX_CONFIG_DIR"] = origEnv;
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("getConfigDir respects REVOLUTX_CONFIG_DIR", () => {
    expect(getConfigDir()).toBe(tmpDir);
  });

  it("getConfigFile returns config.json path", () => {
    expect(getConfigFile()).toBe(join(tmpDir, "config.json"));
  });

  it("getPrivateKeyFile returns private.pem path", () => {
    expect(getPrivateKeyFile()).toBe(join(tmpDir, "private.pem"));
  });

  it("getPublicKeyFile returns public.pem path", () => {
    expect(getPublicKeyFile()).toBe(join(tmpDir, "public.pem"));
  });

  it("ensureConfigDir creates the directory", () => {
    const subDir = join(tmpDir, "sub", "dir");
    process.env["REVOLUTX_CONFIG_DIR"] = subDir;
    ensureConfigDir();
    expect(existsSync(subDir)).toBe(true);
  });

  it("loadConfig returns defaults when no file exists", () => {
    const config = loadConfig();
    expect(config.api_key).toBe("");
    expect(config.private_key_path).toBe("");
  });

  it("loadConfig returns defaults for invalid JSON", () => {
    writeFileSync(join(tmpDir, "config.json"), "not json", "utf-8");
    const config = loadConfig();
    expect(config.api_key).toBe("");
  });

  it("saveConfig and loadConfig roundtrip", () => {
    const apiKey = "a".repeat(64);
    saveConfig({ api_key: apiKey, private_key_path: "/some/path" });
    const loaded = loadConfig();
    expect(loaded.api_key).toBe(apiKey);
    expect(loaded.private_key_path).toBe("/some/path");
  });

  it("saveConfig creates config directory if needed", () => {
    const subDir = join(tmpDir, "new-dir");
    process.env["REVOLUTX_CONFIG_DIR"] = subDir;
    saveConfig({ api_key: "b".repeat(64), private_key_path: "" });
    expect(existsSync(join(subDir, "config.json"))).toBe(true);
  });

  it("isConfigured returns false when no api_key", () => {
    expect(isConfigured()).toBe(false);
  });

  it("isConfigured returns false when api_key set but no private key file", () => {
    saveConfig({ api_key: "c".repeat(64), private_key_path: "" });
    expect(isConfigured()).toBe(false);
  });

  it("isConfigured returns true when api_key and private key file exist", () => {
    saveConfig({ api_key: "d".repeat(64), private_key_path: "" });
    writeFileSync(getPrivateKeyFile(), "dummy", "utf-8");
    expect(isConfigured()).toBe(true);
  });

  it("loadConfig rejects invalid api_key", () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({ api_key: "short" }),
      "utf-8",
    );
    // Invalid key should fall back to defaults
    const config = loadConfig();
    expect(config.api_key).toBe("");
  });
});
