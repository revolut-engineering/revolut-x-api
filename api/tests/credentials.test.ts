import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { platform, tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  inspectCredentials,
  inspectPrivateKey,
  loadCredentials,
} from "../src/auth/credentials.js";
import {
  generateKeypair,
  moveKeypairAside,
  publicKeyFileFor,
} from "../src/auth/keypair.js";
import {
  ensureConfigDir,
  loadConfig,
  saveConfig,
  writeFileAtomic,
} from "../src/config/settings.js";
import { RevolutXClient } from "../src/client.js";
import {
  AuthNotConfiguredError,
  InsecureKeyPermissionsError,
  InvalidCredentialsError,
} from "../src/http/errors.js";

const API_KEY = "a".repeat(64);
const posix = platform() !== "win32";
const canChmod =
  posix && typeof process.getuid === "function"
    ? process.getuid() !== 0
    : false;

function pem(type: "ed25519" | "rsa"): string {
  const pair =
    type === "rsa"
      ? generateKeyPairSync("rsa", { modulusLength: 1024 })
      : generateKeyPairSync("ed25519");
  return pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
}

describe("credentials", () => {
  let dir: string;
  const previousDir = process.env.REVOLUTX_CONFIG_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "revx-creds-"));
    process.env.REVOLUTX_CONFIG_DIR = dir;
  });

  afterEach(() => {
    if (previousDir === undefined) delete process.env.REVOLUTX_CONFIG_DIR;
    else process.env.REVOLUTX_CONFIG_DIR = previousDir;
    rmSync(dir, { recursive: true, force: true });
  });

  const configPath = () => join(dir, "config.json");
  const keyPath = () => join(dir, "private.pem");

  function writeConfig(content: unknown): void {
    writeFileSync(
      configPath(),
      typeof content === "string" ? content : JSON.stringify(content),
      { mode: 0o600 },
    );
  }

  function writeKey(content: string, path = keyPath()): void {
    writeFileSync(path, content, { mode: 0o600 });
  }

  describe("inspectCredentials", () => {
    it("is ready with an API key and an Ed25519 key", () => {
      // given
      writeConfig({ api_key: API_KEY });
      writeKey(pem("ed25519"));

      // when
      const check = inspectCredentials();

      // then
      expect(check.status).toBe("ready");
    });

    it("reports a missing API key when there is no config", () => {
      expect(inspectCredentials()).toEqual({
        status: "missing",
        missing: "api_key",
      });
    });

    it("names a private key that is missing while an API key is set", () => {
      // given
      writeConfig({ api_key: API_KEY });

      // then
      expect(inspectCredentials()).toEqual({
        status: "invalid",
        issue: {
          file: "private_key",
          fault: "missing",
          path: keyPath(),
          problem: `The private key ${keyPath()} is missing.`,
        },
      });
    });

    it("names a config file that is not valid JSON", () => {
      // given
      writeConfig("{ broken");

      // then
      expect(inspectCredentials()).toEqual({
        status: "invalid",
        issue: {
          file: "config",
          fault: "malformed",
          path: configPath(),
          problem: `The config file ${configPath()} is not valid JSON.`,
        },
      });
    });

    it.each([null, [], "abc", 1])(
      "names a config file that holds %j",
      (content) => {
        // given
        writeConfig(JSON.stringify(content));

        // then
        expect(inspectCredentials()).toMatchObject({
          status: "invalid",
          issue: {
            fault: "malformed",
            problem: `The config file ${configPath()} is not a settings object.`,
          },
        });
      },
    );

    it("reads a config file that starts with a byte order mark", () => {
      // given
      writeConfig(`\uFEFF${JSON.stringify({ api_key: API_KEY })}`);
      writeKey(pem("ed25519"));

      // then
      expect(inspectCredentials().status).toBe("ready");
    });

    it("reads a config file whose own fields include status", () => {
      // given
      writeConfig({ api_key: API_KEY, status: "x" });
      writeKey(pem("ed25519"));

      // then
      expect(inspectCredentials().status).toBe("ready");
    });

    it.each([12345, { key: 1 }, "short"])(
      "names an API key %j that is not 64 letters and digits",
      (apiKey) => {
        // given
        writeConfig({ api_key: apiKey });
        writeKey(pem("ed25519"));

        // then
        expect(inspectCredentials()).toMatchObject({
          status: "invalid",
          issue: {
            file: "config",
            fault: "malformed",
            problem: `The config file ${configPath()} has an API key that is not 64 letters and digits.`,
          },
        });
      },
    );

    it("uses a private key kept at another path", () => {
      // given
      const elsewhere = join(dir, "elsewhere.pem");
      writeConfig({ api_key: API_KEY, private_key_path: elsewhere });
      writeKey(pem("ed25519"), elsewhere);

      // when
      const check = inspectCredentials();

      // then
      expect(check).toMatchObject({
        status: "ready",
        credentials: { privateKeyPath: elsewhere },
      });
    });

    it("names the configured key path when no key is anywhere", () => {
      // given
      const gone = join(dir, "gone.pem");
      writeConfig({ api_key: API_KEY, private_key_path: gone });

      // then
      expect(inspectCredentials()).toMatchObject({
        issue: {
          fault: "missing",
          path: gone,
          problem: `The private key ${gone} is missing.`,
        },
      });
    });

    it.skipIf(!canChmod)(
      "says a key in a folder it can't open is unreadable, not missing",
      () => {
        // given
        const folder = join(dir, "keys");
        mkdirSync(folder);
        const key = join(folder, "custom.pem");
        writeFileSync(key, pem("ed25519"), { mode: 0o600 });
        writeConfig({ api_key: API_KEY, private_key_path: key });
        chmodSync(folder, 0o000);

        // when
        const check = inspectCredentials();
        chmodSync(folder, 0o700);

        // then
        expect(check).toMatchObject({
          issue: {
            fault: "unreadable",
            path: key,
            problem: `The private key ${key} can't be read (EACCES).`,
          },
        });
      },
    );

    it("reads an API key with spaces around it", () => {
      // given
      writeConfig({ api_key: ` ${API_KEY}\n` });
      writeKey(pem("ed25519"));

      // then
      expect(inspectCredentials()).toMatchObject({
        status: "ready",
        credentials: { apiKey: API_KEY },
      });
    });

    it("falls back to the usual key when the other path is gone", () => {
      // given
      writeConfig({
        api_key: API_KEY,
        private_key_path: join(dir, "gone.pem"),
      });
      writeKey(pem("ed25519"));

      // then
      expect(inspectCredentials()).toMatchObject({
        status: "ready",
        credentials: { privateKeyPath: keyPath() },
      });
    });

    it("says a config folder is not a file, without permission advice", () => {
      // given
      mkdirSync(configPath(), { mode: 0o755 });

      // then
      expect(inspectCredentials()).toMatchObject({
        status: "invalid",
        issue: {
          file: "config",
          fault: "not_a_file",
          problem: `The config file ${configPath()} is not a file.`,
        },
      });
    });

    it("says a private key folder is not a file", () => {
      // given
      writeConfig({ api_key: API_KEY });
      mkdirSync(keyPath(), { mode: 0o755 });

      // then
      expect(inspectCredentials()).toMatchObject({
        issue: {
          file: "private_key",
          fault: "not_a_file",
        },
      });
    });

    it.skipIf(!canChmod)("names a config file it can't read", () => {
      // given
      writeConfig({ api_key: API_KEY });
      chmodSync(configPath(), 0o000);

      // then
      expect(inspectCredentials()).toMatchObject({
        issue: {
          file: "config",
          fault: "unreadable",
          problem: `The config file ${configPath()} can't be read (EACCES).`,
        },
      });
    });

    it.skipIf(!canChmod)("names a private key it can't read", () => {
      // given
      writeConfig({ api_key: API_KEY });
      writeKey(pem("ed25519"));
      chmodSync(keyPath(), 0o000);

      // then
      expect(inspectCredentials()).toMatchObject({
        issue: {
          file: "private_key",
          fault: "unreadable",
          problem: `The private key ${keyPath()} can't be read (EACCES).`,
        },
      });
    });

    it.skipIf(!posix)("still refuses a private key others can read", () => {
      // given
      writeConfig({ api_key: API_KEY });
      writeKey(pem("ed25519"));
      chmodSync(keyPath(), 0o644);

      // then
      expect(() => inspectCredentials()).toThrow(InsecureKeyPermissionsError);
      expect(() => new RevolutXClient()).toThrow(InsecureKeyPermissionsError);
    });

    it.skipIf(!posix)("still refuses a config file others can read", () => {
      // given
      writeConfig({ api_key: API_KEY });
      chmodSync(configPath(), 0o644);

      // then
      expect(() => inspectCredentials()).toThrow(InsecureKeyPermissionsError);
    });

    it("keeps loadCredentials returning null for anything not ready", () => {
      // given
      writeConfig({ api_key: API_KEY });
      writeKey("not a key");

      // then
      expect(loadCredentials()).toBeNull();
    });
  });

  describe("inspectPrivateKey", () => {
    function problemFor(content: string): string | undefined {
      writeKey(content);
      const check = inspectPrivateKey(keyPath());
      return check.status === "invalid" ? check.issue.problem : undefined;
    }

    it("names an empty key", () => {
      expect(problemFor("")).toBe(`The private key ${keyPath()} is empty.`);
    });

    it("names a key protected by a passphrase", () => {
      const encrypted = generateKeyPairSync("ed25519").privateKey.export({
        type: "pkcs8",
        format: "pem",
        cipher: "aes-256-cbc",
        passphrase: "secret",
      }) as string;

      expect(problemFor(encrypted)).toBe(
        `The private key ${keyPath()} is protected by a passphrase, which is not supported.`,
      );
    });

    it("names a key in OpenSSH format", () => {
      expect(
        problemFor(
          "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n",
        ),
      ).toBe(
        `The private key ${keyPath()} is in OpenSSH format. A PEM (PKCS #8) Ed25519 key is needed.`,
      );
    });

    it("names a public key saved in place of the private key", () => {
      const publicPem = generateKeyPairSync("ed25519").publicKey.export({
        type: "spki",
        format: "pem",
      }) as string;

      expect(problemFor(publicPem)).toBe(
        `The private key ${keyPath()} holds a public key, not the private key.`,
      );
    });

    it("names a file that is not a key", () => {
      expect(problemFor("not a key")).toBe(
        `The private key ${keyPath()} is not a valid PEM private key.`,
      );
    });

    it("names a key of the wrong type", () => {
      expect(problemFor(pem("rsa"))).toBe(
        `The private key ${keyPath()} is not an Ed25519 key (found rsa).`,
      );
    });
  });

  describe("client", () => {
    it("refuses requests with the issue, as a kind of not-configured error", async () => {
      // given
      writeConfig({ api_key: API_KEY });
      writeKey("not a key");
      const client = new RevolutXClient();

      // when
      const request = client.getBalances();

      // then
      expect(client.isAuthenticated).toBe(false);
      expect(client.credentialsIssue).toEqual({
        file: "private_key",
        fault: "malformed",
        path: keyPath(),
        problem: `The private key ${keyPath()} is not a valid PEM private key.`,
      });
      await expect(request).rejects.toBeInstanceOf(InvalidCredentialsError);
      await expect(request).rejects.toBeInstanceOf(AuthNotConfiguredError);
      await expect(request).rejects.toMatchObject({
        issue: { fault: "malformed" },
      });
    });

    it.skipIf(!canChmod)(
      "keeps the error code of a private key it can't read",
      async () => {
        // given
        writeConfig({ api_key: API_KEY });
        writeKey(pem("ed25519"));
        chmodSync(keyPath(), 0o000);
        const client = new RevolutXClient();

        // when
        const request = client.getBalances();

        // then
        expect(client.credentialsIssue).toMatchObject({
          file: "private_key",
          fault: "unreadable",
          code: "EACCES",
        });
        await expect(request).rejects.toMatchObject({
          issue: { code: "EACCES" },
        });
      },
    );

    it("asks for setup when nothing is configured", () => {
      // given
      const client = new RevolutXClient();

      // then
      expect(() => client.assertAuthenticated()).toThrow(
        AuthNotConfiguredError,
      );
      expect(() => client.assertAuthenticated()).not.toThrow(
        InvalidCredentialsError,
      );
    });
  });

  describe("settings files", () => {
    it.each([null, [], "abc"])("loads %j as empty settings", (content) => {
      // given
      writeConfig(JSON.stringify(content));

      // then
      expect(loadConfig()).toEqual({});
    });

    it("drops settings that are not text", () => {
      // given
      writeConfig({ api_key: 12345, private_key_path: {}, other: true });

      // then
      expect(loadConfig()).toEqual({
        other: true,
        api_key: undefined,
        private_key_path: undefined,
      });
    });

    it("refuses to load a config folder, so nothing is saved over it", () => {
      // given
      mkdirSync(configPath(), { mode: 0o755 });

      // then
      expect(() => loadConfig()).toThrow(InvalidCredentialsError);
      expect(() => loadConfig()).toThrow(
        `The config file ${configPath()} is not a file.`,
      );
    });

    it.skipIf(!canChmod)("refuses to load a config file it can't read", () => {
      // given
      writeConfig({ api_key: API_KEY, other: true });
      chmodSync(configPath(), 0o000);

      // then
      expect(() => loadConfig()).toThrow(
        `The config file ${configPath()} can't be read (EACCES).`,
      );
    });

    it.skipIf(!posix)(
      "saves through a linked config file and keeps the link",
      () => {
        // given
        const real = join(dir, "real.json");
        writeFileSync(real, "{}", { mode: 0o600 });
        symlinkSync(real, configPath());

        // when
        saveConfig({ api_key: API_KEY });

        // then
        expect(lstatSync(configPath()).isSymbolicLink()).toBe(true);
        expect(JSON.parse(readFileSync(real, "utf-8"))).toEqual({
          api_key: API_KEY,
        });
      },
    );

    it.skipIf(!posix)(
      "saves settings readable only by the owner, even over a looser file",
      () => {
        // given
        writeFileSync(configPath(), "{}", { mode: 0o644 });

        // when
        saveConfig({ api_key: API_KEY });

        // then
        expect(statSync(configPath()).mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(configPath(), "utf-8"))).toEqual({
          api_key: API_KEY,
        });
        expect(readdirSync(dir)).toEqual(["config.json"]);
      },
    );

    it.skipIf(!posix)(
      "writes a new key pair readable only by the owner, even over a looser file",
      () => {
        // given
        writeKey("old");
        chmodSync(keyPath(), 0o644);

        // when
        generateKeypair(keyPath(), join(dir, "public.pem"));

        // then
        expect(statSync(keyPath()).mode & 0o777).toBe(0o600);
        expect(inspectPrivateKey(keyPath()).status).toBe("ready");
      },
    );

    it.skipIf(!canChmod)(
      "saves in place when the folder of an existing file can't take new files",
      () => {
        // given
        const real = join(dir, "real");
        mkdirSync(real);
        writeFileSync(join(real, "config.json"), "{}", { mode: 0o600 });
        symlinkSync(join(real, "config.json"), configPath());
        chmodSync(real, 0o500);

        // when
        saveConfig({ api_key: API_KEY });
        chmodSync(real, 0o700);

        // then
        expect(
          JSON.parse(readFileSync(join(real, "config.json"), "utf-8")),
        ).toEqual({ api_key: API_KEY });
      },
    );

    it.skipIf(!posix)("creates the target of a dangling config link", () => {
      // given
      const target = join(dir, "elsewhere.json");
      symlinkSync(target, configPath());

      // when
      saveConfig({ api_key: API_KEY });

      // then
      expect(lstatSync(configPath()).isSymbolicLink()).toBe(true);
      expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({
        api_key: API_KEY,
      });
    });

    it.skipIf(!posix)(
      "resolves a relative dangling link from its real folder",
      () => {
        // given
        const real = join(dir, "b", "real");
        mkdirSync(real, { recursive: true });
        mkdirSync(join(dir, "b", "store"));
        mkdirSync(join(dir, "a"));
        mkdirSync(join(dir, "a", "store"));
        symlinkSync(real, join(dir, "a", "cfg"));
        symlinkSync("../store/config.json", join(real, "config.json"));
        process.env.REVOLUTX_CONFIG_DIR = join(dir, "a", "cfg");

        // when
        saveConfig({ api_key: API_KEY });

        // then
        expect(existsSync(join(dir, "b", "store", "config.json"))).toBe(true);
        expect(existsSync(join(dir, "a", "store", "config.json"))).toBe(false);
      },
    );

    it.skipIf(!posix)(
      "says when a linked config points into a missing folder",
      () => {
        // given
        symlinkSync(join(dir, "nofolder", "config.json"), configPath());

        // then
        expect(() => saveConfig({ api_key: API_KEY })).toThrow(
          `Can't save ${configPath()}: the folder ${join(dir, "nofolder")} does not exist.`,
        );
      },
    );

    it.skipIf(!posix)(
      "treats the default key reached through a link as the default",
      () => {
        // given
        const alias = join(dir, "..", `${basename(dir)}-alias`);
        symlinkSync(dir, alias);

        // when
        const publicPath = publicKeyFileFor(join(alias, "private.pem"));
        rmSync(alias);

        // then
        expect(publicPath).toBe(join(dir, "public.pem"));
      },
    );

    it.skipIf(!canChmod)("says which folder can't be created", () => {
      // given
      const locked = join(dir, "locked");
      mkdirSync(locked);
      chmodSync(locked, 0o500);
      process.env.REVOLUTX_CONFIG_DIR = join(locked, "cfg");

      // when
      const create = () => ensureConfigDir();

      // then
      expect(create).toThrow(
        `Can't create the config folder ${join(locked, "cfg")} (EACCES). Make sure the folders above it belong to you and you can write to them.`,
      );
      chmodSync(locked, 0o700);
    });

    it.skipIf(!canChmod)(
      "names the folder when a new file can't be written",
      () => {
        // given
        const locked = join(dir, "locked");
        mkdirSync(locked);
        chmodSync(locked, 0o500);

        // when
        const save = () => writeFileAtomic(join(locked, "x.json"), "{}");

        // then
        expect(save).toThrow(
          `Can't save ${join(locked, "x.json")}: the folder ${locked} can't be written to (EACCES).`,
        );
        chmodSync(locked, 0o700);
      },
    );

    it.skipIf(!posix)(
      "follows a chain of dangling links to the final file",
      () => {
        // given
        mkdirSync(join(dir, "sub"));
        mkdirSync(join(dir, "store"));
        symlinkSync(join("sub", "link2"), configPath());
        symlinkSync(
          join("..", "store", "final.json"),
          join(dir, "sub", "link2"),
        );

        // when
        saveConfig({ api_key: API_KEY });

        // then
        expect(lstatSync(join(dir, "sub", "link2")).isSymbolicLink()).toBe(
          true,
        );
        expect(
          JSON.parse(readFileSync(join(dir, "store", "final.json"), "utf-8")),
        ).toEqual({ api_key: API_KEY });
      },
    );

    it("treats another name for the default key file as the default", () => {
      // given
      writeKey(pem("ed25519"));
      const otherName = join(dir, "other.pem");
      linkSync(keyPath(), otherName);

      // then
      expect(publicKeyFileFor(otherName)).toBe(join(dir, "public.pem"));
    });

    it.skipIf(!canChmod)("keeps the error code of a file it can't read", () => {
      // given
      writeConfig({ api_key: API_KEY });
      chmodSync(configPath(), 0o000);

      // then
      expect(inspectCredentials()).toMatchObject({
        issue: {
          fault: "unreadable",
          code: "EACCES",
        },
      });
    });

    it("keeps a custom key's public key next to it", () => {
      expect(publicKeyFileFor(keyPath())).toBe(join(dir, "public.pem"));
      expect(publicKeyFileFor("/keys/revx.pem")).toBe("/keys/revx.public.pem");
    });

    it("moves a key pair aside without losing it", () => {
      // given
      writeKey("broken");
      chmodSync(keyPath(), 0o644);
      writeFileSync(join(dir, "public.pem"), "public");

      // when
      const moved = moveKeypairAside(keyPath(), join(dir, "public.pem"));

      // then
      expect(existsSync(keyPath())).toBe(false);
      expect(existsSync(join(dir, "public.pem"))).toBe(false);
      expect(readFileSync(moved, "utf-8")).toBe("broken");
      expect(moved).toMatch(/private\.pem\.replaced-[\dT-]+Z$/);
      if (posix) expect(statSync(moved).mode & 0o777).toBe(0o600);
      expect(readdirSync(dir)).toContainEqual(
        expect.stringMatching(/^public\.pem\.replaced-/),
      );
    });
  });
});
