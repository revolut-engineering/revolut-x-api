import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerConfigureCommand } from "../../src/commands/configure.js";

const prompts = vi.hoisted(() => ({
  answers: [] as (string | null)[],
  confirm: vi.fn(async () => false),
}));

vi.mock("../../src/util/session.js", () => ({
  promptHiddenInput: vi.fn(async () =>
    prompts.answers.length > 0 ? prompts.answers.shift()! : null,
  ),
  confirm: prompts.confirm,
}));

const API_KEY = "K".repeat(64);

describe("configure wizard", () => {
  let dir: string;
  let output: string[];
  const previousDir = process.env.REVOLUTX_CONFIG_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "revx-wizard-"));
    process.env.REVOLUTX_CONFIG_DIR = dir;
    output = [];
    const capture = (line: unknown) => {
      output.push(String(line));
    };
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    prompts.answers = [];
    prompts.confirm.mockReset();
    prompts.confirm.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    if (previousDir === undefined) delete process.env.REVOLUTX_CONFIG_DIR;
    else process.env.REVOLUTX_CONFIG_DIR = previousDir;
    rmSync(dir, { recursive: true, force: true });
  });

  const configPath = () => join(dir, "config.json");
  const keyPath = () => join(dir, "private.pem");
  const text = () => output.join("\n");

  function writeKey(content: string): void {
    writeFileSync(keyPath(), content, { mode: 0o600 });
  }

  function ed25519Pem(): string {
    return generateKeyPairSync("ed25519").privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string;
  }

  async function runWizard(): Promise<void> {
    const program = new Command();
    registerConfigureCommand(program, "1.0.0");
    await program.parseAsync(["node", "revx", "configure"]);
  }

  function savedConfig(): Record<string, unknown> {
    return JSON.parse(readFileSync(configPath(), "utf-8")) as Record<
      string,
      unknown
    >;
  }

  it("makes a key pair and saves the API key on a fresh setup", async () => {
    // given
    prompts.answers = [API_KEY];

    // when
    await runWizard();

    // then
    expect(createPrivateKey(readFileSync(keyPath())).asymmetricKeyType).toBe(
      "ed25519",
    );
    expect(savedConfig()).toEqual({
      api_key: API_KEY,
      private_key_path: keyPath(),
    });
    expect(text()).toContain("Configuration complete!");
    expect(process.exitCode).toBeUndefined();
  });

  it("asks a second time after a key in the wrong format", async () => {
    // given
    prompts.answers = ["too short", API_KEY];

    // when
    await runWizard();

    // then
    expect(text()).toContain("Invalid API key format.");
    expect(savedConfig().api_key).toBe(API_KEY);
  });

  it("leaves a broken key alone when the user says no", async () => {
    // given
    writeKey("junk");

    // when
    await runWizard();

    // then
    expect(prompts.confirm).toHaveBeenCalledWith(
      "Move it aside and make a new key pair?",
    );
    expect(readFileSync(keyPath(), "utf-8")).toBe("junk");
    expect(text()).toContain(
      `The private key ${keyPath()} is not a valid PEM private key.`,
    );
    expect(text()).toContain("Nothing changed.");
    expect(process.exitCode).toBe(1);
  });

  it("moves a broken key aside and makes a new pair when the user says yes", async () => {
    // given
    writeKey("junk");
    prompts.confirm.mockResolvedValue(true);
    prompts.answers = [API_KEY];

    // when
    await runWizard();

    // then
    const moved = readdirSync(dir).find((name) =>
      name.startsWith("private.pem.replaced-"),
    );
    expect(moved).toBeDefined();
    expect(readFileSync(join(dir, moved!), "utf-8")).toBe("junk");
    expect(createPrivateKey(readFileSync(keyPath())).asymmetricKeyType).toBe(
      "ed25519",
    );
    expect(text()).toContain(`The old key is now at ${join(dir, moved!)}.`);
    expect(savedConfig().api_key).toBe(API_KEY);
    expect(process.exitCode).toBeUndefined();
  });

  it("says the saved API key belongs to a lost key pair", async () => {
    // given
    writeFileSync(configPath(), JSON.stringify({ api_key: API_KEY }), {
      mode: 0o600,
    });
    prompts.answers = [""];

    // when
    await runWizard();

    // then
    expect(existsSync(keyPath())).toBe(true);
    expect(text()).toContain(
      "The saved API key was made for the old key pair.",
    );
    expect(text()).toContain(
      "Register the new public key with Revolut X, create an API key for it and save it with: revx configure set --api-key <key>",
    );
    expect(process.exitCode).toBe(1);
  });

  it("stops on a config file it can't use, before touching anything", async () => {
    // given
    mkdirSync(configPath());

    // when
    await runWizard();

    // then
    expect(text()).toContain(`The config file ${configPath()} is not a file.`);
    expect(text()).toContain(`Move the folder ${configPath()} out of the way`);
    expect(existsSync(keyPath())).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it("replaces a config file that is not valid JSON once a key is entered", async () => {
    // given
    writeFileSync(configPath(), "{ broken", { mode: 0o600 });
    writeKey(ed25519Pem());
    prompts.answers = [API_KEY];

    // when
    await runWizard();

    // then
    expect(text()).toContain(
      `The config file ${configPath()} is not valid JSON. Saving an API key replaces it.`,
    );
    expect(savedConfig().api_key).toBe(API_KEY);
    expect(process.exitCode).toBeUndefined();
  });

  it("ends without a key when the input runs out", async () => {
    // when
    await runWizard();

    // then
    expect(text()).toContain("No API key set.");
    expect(existsSync(configPath())).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it("treats a saved API key in the wrong format as missing", async () => {
    // given
    writeFileSync(configPath(), JSON.stringify({ api_key: "short" }), {
      mode: 0o600,
    });
    writeKey(ed25519Pem());
    prompts.answers = [API_KEY];

    // when
    await runWizard();

    // then
    expect(text()).not.toContain("API Key already configured");
    expect(text()).toContain("No API Key configured.");
    expect(savedConfig().api_key).toBe(API_KEY);
  });

  it("makes the new pair at the usual path when a key kept elsewhere is gone", async () => {
    // given
    const gone = join(dir, "keys", "gone.pem");
    writeFileSync(
      configPath(),
      JSON.stringify({ api_key: API_KEY, private_key_path: gone }),
      { mode: 0o600 },
    );
    prompts.answers = [API_KEY.toLowerCase()];

    // when
    await runWizard();

    // then
    expect(createPrivateKey(readFileSync(keyPath())).asymmetricKeyType).toBe(
      "ed25519",
    );
    expect(savedConfig().private_key_path).toBe(keyPath());
    expect(process.exitCode).toBeUndefined();
  });
});

describe("configure set", () => {
  let dir: string;
  const previousDir = process.env.REVOLUTX_CONFIG_DIR;
  const canChmod =
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    process.getuid() !== 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "revx-set-"));
    process.env.REVOLUTX_CONFIG_DIR = dir;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousDir === undefined) delete process.env.REVOLUTX_CONFIG_DIR;
    else process.env.REVOLUTX_CONFIG_DIR = previousDir;
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });

  async function runSet(): Promise<string> {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    const program = new Command();
    registerConfigureCommand(program, "1.0.0");
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "configure",
        "set",
        "--api-key",
        API_KEY,
      ]),
    ).rejects.toThrow("process.exit");
    return errors.join("\n");
  }

  it("stops on a config folder and leaves it alone", async () => {
    // given
    const configPath = join(dir, "config.json");
    mkdirSync(configPath, { mode: 0o755 });

    // when
    const output = await runSet();

    // then
    expect(output).toContain(`The config file ${configPath} is not a file.`);
    expect(output).toContain(`Move the folder ${configPath} out of the way`);
    expect(readdirSync(configPath)).toEqual([]);
  });

  it.skipIf(!canChmod)(
    "stops on a config file it can't read and leaves it alone",
    async () => {
      // given
      const configPath = join(dir, "config.json");
      writeFileSync(configPath, JSON.stringify({ other: true }), {
        mode: 0o600,
      });
      chmodSync(configPath, 0o000);

      // when
      const output = await runSet();

      // then
      expect(output).toContain("can't be read (EACCES)");
      chmodSync(configPath, 0o600);
      expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({
        other: true,
      });
    },
  );
});
