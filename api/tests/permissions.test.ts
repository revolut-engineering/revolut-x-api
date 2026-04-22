import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { generateKeyPairSync, createPrivateKey } from "node:crypto";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import {
  assertSecurePermissions,
  loadConfig,
  saveConfig,
} from "../src/config/settings.js";
import { generateKeypair, loadPrivateKey } from "../src/auth/keypair.js";
import { RevolutXClient } from "../src/client.js";
import { InsecureKeyPermissionsError } from "../src/http/errors.js";

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

describeUnix("enforceKeyPermissions per-request check", () => {
  let dir: string;
  const origEnv = process.env["REVOLUTX_CONFIG_DIR"];

  function okJsonResponse(): Response {
    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "revx-perm-"));
    process.env["REVOLUTX_CONFIG_DIR"] = dir;
    const privPath = join(dir, "private.pem");
    const pubPath = join(dir, "public.pem");
    generateKeypair(privPath, pubPath);
    saveConfig({ api_key: "a".repeat(64) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (origEnv === undefined) delete process.env["REVOLUTX_CONFIG_DIR"];
    else process.env["REVOLUTX_CONFIG_DIR"] = origEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws InsecureKeyPermissionsError on next request after key perms widen (flag on)", async () => {
    const fetchMock = vi.fn(async () => okJsonResponse());
    vi.stubGlobal("fetch", fetchMock);

    const client = new RevolutXClient({ enforceKeyPermissions: true });
    await expect(client.getBalances()).resolves.toBeDefined();

    chmodSync(join(dir, "private.pem"), 0o644);

    await expect(client.getBalances()).rejects.toBeInstanceOf(
      InsecureKeyPermissionsError,
    );
  });

  it("throws InsecureKeyPermissionsError when key file is deleted (flag on)", async () => {
    const fetchMock = vi.fn(async () => okJsonResponse());
    vi.stubGlobal("fetch", fetchMock);

    const client = new RevolutXClient({ enforceKeyPermissions: true });
    await expect(client.getBalances()).resolves.toBeDefined();

    unlinkSync(join(dir, "private.pem"));

    await expect(client.getBalances()).rejects.toBeInstanceOf(
      InsecureKeyPermissionsError,
    );
  });

  it("re-checks permissions on retry branch", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockImplementationOnce(async () => {
      chmodSync(join(dir, "private.pem"), 0o644);
      return new Response("upstream failure", { status: 500 });
    });
    // If the retry check didn't fire we'd reach this second mock and succeed.
    fetchMock.mockImplementationOnce(async () => okJsonResponse());
    vi.stubGlobal("fetch", fetchMock);

    const client = new RevolutXClient({
      enforceKeyPermissions: true,
      maxRetries: 1,
    });

    await expect(client.getBalances()).rejects.toBeInstanceOf(
      InsecureKeyPermissionsError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps signing with cached key after perms widen (flag off, default)", async () => {
    const fetchMock = vi.fn(async () => okJsonResponse());
    vi.stubGlobal("fetch", fetchMock);

    const client = new RevolutXClient();
    await expect(client.getBalances()).resolves.toBeDefined();

    chmodSync(join(dir, "private.pem"), 0o644);

    await expect(client.getBalances()).resolves.toBeDefined();
  });

  it("throws InsecureKeyPermissionsError at construction when flag is on and key has no file path", () => {
    const { privateKey: pem } = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const keyObj = createPrivateKey(pem);

    expect(
      () =>
        new RevolutXClient({
          apiKey: "k".repeat(64),
          privateKey: keyObj,
          enforceKeyPermissions: true,
          autoLoadCredentials: false,
        }),
    ).toThrow(InsecureKeyPermissionsError);
  });
});
