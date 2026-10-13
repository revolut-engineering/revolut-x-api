import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerConfigureCommand } from "../../src/commands/configure.js";

const {
  mockLoadConfig,
  mockSaveConfig,
  mockGenerateKeypair,
  mockLoadPrivateKey,
  mockGetPublicKeyPem,
  mockExistsSync,
  mockInspectCredentials,
} = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockSaveConfig: vi.fn(),
  mockGenerateKeypair: vi.fn(),
  mockLoadPrivateKey: vi.fn(),
  mockGetPublicKeyPem: vi.fn(),
  mockExistsSync: vi.fn(),
  mockInspectCredentials: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: mockExistsSync };
});

vi.mock("@revolut/revolut-x-api", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getConfigDir: () => "/tmp/revx-test",
    ensureConfigDir: vi.fn(),
    loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
    saveConfig: (...args: unknown[]) => mockSaveConfig(...args),
    inspectCredentials: (...args: unknown[]) => mockInspectCredentials(...args),
    generateKeypair: (...args: unknown[]) => mockGenerateKeypair(...args),
    loadPrivateKey: (...args: unknown[]) => mockLoadPrivateKey(...args),
    getPublicKeyPem: (...args: unknown[]) => mockGetPublicKeyPem(...args),
    getPrivateKeyFile: () => "/tmp/revx-test/private.pem",
    getPublicKeyFile: () => "/tmp/revx-test/public.pem",
    resolvePrivateKeyFile: (configured?: string) =>
      configured ?? "/tmp/revx-test/private.pem",
    isMissing: (path: string) => !mockExistsSync(path),
  };
});

vi.mock("../../src/util/session.js", () => ({
  promptHiddenInput: vi.fn().mockResolvedValue(""),
  confirm: vi.fn().mockResolvedValue(false),
}));

describe("configure get", () => {
  let program: Command;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockInspectCredentials.mockReturnValue({
      status: "missing",
      missing: "api_key",
    });
    program = new Command().exitOverride();
    registerConfigureCommand(program, "1.0.0");
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("shows config directory", async () => {
    mockLoadConfig.mockReturnValue({});
    mockExistsSync.mockReturnValue(false);

    await program.parseAsync(["node", "revx", "configure", "get"]);

    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("/tmp/revx-test");
  });

  it("shows masked API key when configured", async () => {
    mockLoadConfig.mockReturnValue({
      api_key: "abcd1234567890123456789012345678901234567890123456789012efgh",
    });
    mockInspectCredentials.mockReturnValue({ status: "ready" });
    mockExistsSync.mockReturnValue(true);

    await program.parseAsync(["node", "revx", "configure", "get"]);

    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("abcd****efgh");
    expect(output).not.toContain(
      "abcd1234567890123456789012345678901234567890123456789012efgh",
    );
  });

  it("shows not-set when API key is absent", async () => {
    mockLoadConfig.mockReturnValue({});
    mockExistsSync.mockReturnValue(false);

    await program.parseAsync(["node", "revx", "configure", "get"]);

    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("not set");
  });

  it("says what is wrong with credentials it can't use", async () => {
    mockLoadConfig.mockReturnValue({ api_key: "a".repeat(64) });
    mockExistsSync.mockReturnValue(true);
    mockInspectCredentials.mockReturnValue({
      status: "invalid",
      issue: {
        file: "private_key",
        fault: "malformed",
        path: "/tmp/revx-test/private.pem",
        problem:
          "The private key /tmp/revx-test/private.pem is not a valid PEM private key.",
      },
    });

    await program.parseAsync(["node", "revx", "configure", "get"]);

    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain(
      "no: The private key /tmp/revx-test/private.pem is not a valid PEM private key.",
    );
  });

  it("gives the fix for a key it can't read", async () => {
    mockLoadConfig.mockReturnValue({ api_key: "a".repeat(64) });
    mockExistsSync.mockReturnValue(true);
    mockInspectCredentials.mockReturnValue({
      status: "invalid",
      issue: {
        file: "private_key",
        fault: "unreadable",
        path: "/tmp/revx-test/private.pem",
        problem:
          "The private key /tmp/revx-test/private.pem can't be read (EACCES).",
        code: "EACCES",
      },
    });

    await program.parseAsync(["node", "revx", "configure", "get"]);

    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain(
      "chmod 700 /tmp/revx-test and chmod 600 /tmp/revx-test/private.pem",
    );
  });

  it("still shows the table when the config file can't be loaded", async () => {
    mockLoadConfig.mockImplementation(() => {
      throw new Error("Refusing to load config file: insecure permissions");
    });
    mockExistsSync.mockReturnValue(false);
    mockInspectCredentials.mockImplementation(() => {
      throw new Error("Refusing to load config file: insecure permissions");
    });

    await program.parseAsync(["node", "revx", "configure", "get"]);

    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("/tmp/revx-test");
    expect(output).toContain(
      "no: Refusing to load config file: insecure permissions",
    );
  });

  it("names a private key kept at another path", async () => {
    mockLoadConfig.mockReturnValue({
      api_key: "a".repeat(64),
      private_key_path: "/keys/revx.pem",
    });
    mockExistsSync.mockImplementation(
      (path: string) => path === "/keys/revx.pem",
    );
    mockInspectCredentials.mockReturnValue({ status: "ready" });

    await program.parseAsync(["node", "revx", "configure", "get"]);

    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("configured");
    expect(output).toContain("/keys/revx.pem");
  });

  it("does not show passkey field", async () => {
    mockLoadConfig.mockReturnValue({});
    mockExistsSync.mockReturnValue(false);

    await program.parseAsync(["node", "revx", "configure", "get"]);

    const output = logSpy.mock.calls.flat().join(" ").toLowerCase();
    expect(output).not.toContain("passkey");
  });
});

describe("configure set", () => {
  let program: Command;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command().exitOverride();
    registerConfigureCommand(program, "1.0.0");
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    mockLoadConfig.mockReturnValue({});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("saves a valid API key", async () => {
    const validKey = "a".repeat(32) + "B".repeat(32);
    await program.parseAsync([
      "node",
      "revx",
      "configure",
      "set",
      "--api-key",
      validKey,
    ]);

    expect(mockSaveConfig).toHaveBeenCalledOnce();
    const saved = mockSaveConfig.mock.calls[0][0] as Record<string, unknown>;
    expect(saved.api_key).toBe(validKey);
    expect(saved.private_key_path).toBe("/tmp/revx-test/private.pem");
  });

  it("keeps a private key kept at another path", async () => {
    mockLoadConfig.mockReturnValue({ private_key_path: "/keys/revx.pem" });

    await program.parseAsync([
      "node",
      "revx",
      "configure",
      "set",
      "--api-key",
      "a".repeat(64),
    ]);

    const saved = mockSaveConfig.mock.calls[0][0] as Record<string, unknown>;
    expect(saved.private_key_path).toBe("/keys/revx.pem");
  });

  it("rejects an API key that is too short", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "configure",
        "set",
        "--api-key",
        "tooshort",
      ]),
    ).rejects.toThrow("process.exit");

    expect(mockSaveConfig).not.toHaveBeenCalled();
    const errOutput = errSpy.mock.calls.flat().join(" ");
    expect(errOutput).toContain("Invalid API key format");
  });

  it("rejects an API key with invalid characters", async () => {
    const badKey = "!".repeat(64);
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "configure",
        "set",
        "--api-key",
        badKey,
      ]),
    ).rejects.toThrow("process.exit");

    expect(mockSaveConfig).not.toHaveBeenCalled();
  });

  it("errors when no option is provided", async () => {
    await expect(
      program.parseAsync(["node", "revx", "configure", "set"]),
    ).rejects.toThrow("process.exit");

    const errOutput = errSpy.mock.calls.flat().join(" ");
    expect(errOutput).toContain("No option provided");
  });
});

describe("configure generate-keypair", () => {
  let program: Command;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command().exitOverride();
    registerConfigureCommand(program, "1.0.0");
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("generates a keypair when none exists", async () => {
    mockExistsSync.mockReturnValue(false);
    mockGenerateKeypair.mockReturnValue(
      "-----BEGIN PUBLIC KEY-----\nMOCK\n-----END PUBLIC KEY-----",
    );

    await program.parseAsync(["node", "revx", "configure", "generate-keypair"]);

    expect(mockGenerateKeypair).toHaveBeenCalledOnce();
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("BEGIN PUBLIC KEY");
  });

  it("aborts when a private key already exists and points to the wizard", async () => {
    mockExistsSync.mockReturnValue(true);

    await expect(
      program.parseAsync(["node", "revx", "configure", "generate-keypair"]),
    ).rejects.toThrow("process.exit");

    expect(mockGenerateKeypair).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join(" ")).toContain(
      "To replace a broken key, run 'revx configure'.",
    );
  });
});

describe("configure path", () => {
  let program: Command;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command().exitOverride();
    registerConfigureCommand(program, "1.0.0");
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("prints the config directory", async () => {
    await program.parseAsync(["node", "revx", "configure", "path"]);

    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("/tmp/revx-test");
  });
});
