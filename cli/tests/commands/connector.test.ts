import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerConnectorCommand } from "../../src/commands/connector.js";

const mockLoadConnections = vi.fn();
const mockCreateConnection = vi.fn();
const mockGetConnection = vi.fn();
const mockUpdateConnection = vi.fn();
const mockDeleteConnection = vi.fn();

vi.mock("../../src/db/store.js", () => ({
  loadConnections: () => mockLoadConnections(),
  createConnection: (...args: unknown[]) => mockCreateConnection(...args),
  getConnection: (id: unknown) => mockGetConnection(id),
  updateConnection: (...args: unknown[]) => mockUpdateConnection(...args),
  deleteConnection: (id: unknown) => mockDeleteConnection(id),
}));

vi.mock("api-k9x2a", async (importOriginal) => {
  const actual = await importOriginal();
  class RevolutXError extends Error {}
  class AuthNotConfiguredError extends RevolutXError {}
  class AuthenticationError extends RevolutXError {}
  class RateLimitError extends RevolutXError {}
  class BadRequestError extends RevolutXError {}
  class NotFoundError extends RevolutXError {}
  class NetworkError extends RevolutXError {}
  return {
    ...actual,
    getConfigDir: () => "/tmp/revx-test",
    ensureConfigDir: () => {},
    RevolutXError,
    AuthNotConfiguredError,
    AuthenticationError,
    RateLimitError,
    BadRequestError,
    NotFoundError,
    NetworkError,
  };
});

const sampleConn = {
  id: "conn-abc",
  label: "mybot",
  bot_token: "123456:ABCDEFGHIJKLMNOP",
  chat_id: "789",
  enabled: true,
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-01T00:00:00.000Z",
};

describe("connector telegram add", () => {
  let program: Command;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command().exitOverride();
    registerConnectorCommand(program);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    mockCreateConnection.mockReturnValue(sampleConn);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("creates a connection with default label", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "connector",
      "telegram",
      "add",
      "--token",
      "123456:ABC",
      "--chat-id",
      "789",
    ]);
    expect(mockCreateConnection).toHaveBeenCalledWith(
      "123456:ABC",
      "789",
      "default",
    );
  });

  it("creates a connection with custom label", async () => {
    mockCreateConnection.mockReturnValue({ ...sampleConn, label: "alerts" });
    await program.parseAsync([
      "node",
      "revx",
      "connector",
      "telegram",
      "add",
      "--token",
      "tok",
      "--chat-id",
      "123",
      "--label",
      "alerts",
    ]);
    expect(mockCreateConnection).toHaveBeenCalledWith("tok", "123", "alerts");
  });

  it("displays connection ID after adding", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "connector",
      "telegram",
      "add",
      "--token",
      "tok",
      "--chat-id",
      "123",
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("conn-abc");
  });

  it("outputs masked token in JSON mode", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "connector",
      "telegram",
      "add",
      "--token",
      "123456:ABCDEFGHIJKLMNOP",
      "--chat-id",
      "789",
      "--json",
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    const parsed = JSON.parse(output);
    expect(parsed.id).toBe("conn-abc");
    // Token should be masked, not the full value
    expect(parsed.bot_token).not.toBe("123456:ABCDEFGHIJKLMNOP");
    expect(parsed.bot_token).toContain("****");
  });
});

describe("connector telegram list", () => {
  let program: Command;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command().exitOverride();
    registerConnectorCommand(program);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("displays connections in a table", async () => {
    mockLoadConnections.mockReturnValue([sampleConn]);
    await program.parseAsync(["node", "revx", "connector", "telegram", "list"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("mybot");
    expect(output).toContain("789");
  });

  it("shows empty message when no connections exist", async () => {
    mockLoadConnections.mockReturnValue([]);
    await program.parseAsync(["node", "revx", "connector", "telegram", "list"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("No Telegram connections found");
  });

  it("outputs JSON with masked tokens when --json is set", async () => {
    mockLoadConnections.mockReturnValue([sampleConn]);
    await program.parseAsync([
      "node",
      "revx",
      "connector",
      "telegram",
      "list",
      "--json",
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("conn-abc");
    expect(parsed[0].bot_token).toContain("****");
  });
});

describe("connector telegram delete", () => {
  let program: Command;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command().exitOverride();
    registerConnectorCommand(program);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("deletes a connection and shows success", async () => {
    mockDeleteConnection.mockReturnValue(true);
    await program.parseAsync([
      "node",
      "revx",
      "connector",
      "telegram",
      "delete",
      "conn-abc",
    ]);
    expect(mockDeleteConnection).toHaveBeenCalledWith("conn-abc");
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("conn-abc");
  });

  it("exits with error when connection not found", async () => {
    mockDeleteConnection.mockReturnValue(false);
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "connector",
        "telegram",
        "delete",
        "unknown-id",
      ]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOutput = errSpy.mock.calls.flat().join(" ");
    expect(errOutput).toContain("unknown-id");
  });
});

describe("connector telegram enable/disable", () => {
  let program: Command;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command().exitOverride();
    registerConnectorCommand(program);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("enables a connection", async () => {
    mockUpdateConnection.mockReturnValue({ ...sampleConn, enabled: true });
    await program.parseAsync([
      "node",
      "revx",
      "connector",
      "telegram",
      "enable",
      "conn-abc",
    ]);
    expect(mockUpdateConnection).toHaveBeenCalledWith("conn-abc", {
      enabled: true,
    });
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("conn-abc");
  });

  it("disables a connection", async () => {
    mockUpdateConnection.mockReturnValue({ ...sampleConn, enabled: false });
    await program.parseAsync([
      "node",
      "revx",
      "connector",
      "telegram",
      "disable",
      "conn-abc",
    ]);
    expect(mockUpdateConnection).toHaveBeenCalledWith("conn-abc", {
      enabled: false,
    });
  });

  it("exits with error when enabling a connection that does not exist", async () => {
    mockUpdateConnection.mockReturnValue(undefined);
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "connector",
        "telegram",
        "enable",
        "no-such",
      ]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with error when disabling a connection that does not exist", async () => {
    mockUpdateConnection.mockReturnValue(undefined);
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "connector",
        "telegram",
        "disable",
        "no-such",
      ]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
