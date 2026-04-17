import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  statSync,
} from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import {
  assertSecurePermissions,
  loadConfig,
  saveConfig,
} from "../src/config/settings.js";
import { generateKeypair, loadPrivateKey } from "../src/auth/keypair.js";

const isWindows = platform() === "win32";
const describeUnix = isWindows ? describe.skip : describe;

describeUnix("assertSecurePermissions", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "revx-perm-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes when file has 0o600 permissions", () => {
    const path = join(dir, "secret");
    writeFileSync(path, "data", { mode: 0o600 });
    expect(() => assertSecurePermissions(path, "secret")).not.toThrow();
  });

  it("throws when file is group-readable", () => {
    const path = join(dir, "secret");
    writeFileSync(path, "data", { mode: 0o600 });
    chmodSync(path, 0o640);
    expect(() => assertSecurePermissions(path, "secret")).toThrow(
      /insecure permissions/,
    );
  });

  it("throws when file is world-readable", () => {
    const path = join(dir, "secret");
    writeFileSync(path, "data", { mode: 0o600 });
    chmodSync(path, 0o644);
    expect(() => assertSecurePermissions(path, "secret")).toThrow(/chmod 600/);
  });

  it("is a no-op when file does not exist", () => {
    expect(() =>
      assertSecurePermissions(join(dir, "missing"), "secret"),
    ).not.toThrow();
  });
});

describeUnix("loadPrivateKey permission enforcement", () => {
  let dir: string;
  let privPath: string;
  let pubPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "revx-perm-"));
    privPath = join(dir, "private.pem");
    pubPath = join(dir, "public.pem");
    generateKeypair(privPath, pubPath);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads key at 0o600", () => {
    expect(() => loadPrivateKey(privPath)).not.toThrow();
    expect(statSync(privPath).mode & 0o777).toBe(0o600);
  });

  it("refuses to load a world-readable key", () => {
    chmodSync(privPath, 0o644);
    expect(() => loadPrivateKey(privPath)).toThrow(/insecure permissions/);
  });
});

describeUnix("loadConfig permission enforcement", () => {
  let dir: string;
  const origEnv = process.env["REVOLUTX_CONFIG_DIR"];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "revx-perm-"));
    process.env["REVOLUTX_CONFIG_DIR"] = dir;
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env["REVOLUTX_CONFIG_DIR"];
    else process.env["REVOLUTX_CONFIG_DIR"] = origEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it("saveConfig writes with 0o600", () => {
    saveConfig({ api_key: "a".repeat(64) });
    const mode = statSync(join(dir, "config.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("loadConfig refuses an insecure config file", () => {
    saveConfig({ api_key: "a".repeat(64) });
    chmodSync(join(dir, "config.json"), 0o644);
    expect(() => loadConfig()).toThrow(/insecure permissions/);
  });
});
