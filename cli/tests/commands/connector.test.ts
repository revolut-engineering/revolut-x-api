import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import {
  LOCAL_TIME_NOTE,
  formatLocalDateTime,
} from "../../src/output/formatter.js";
import { registerConnectorCommand } from "../../src/commands/connector.js";

const mockLoadConnections = vi.fn();
const mockCreateConnection = vi.fn();
const mockGetConnection = vi.fn();
const mockUpdateConnection = vi.fn();
const mockDeleteConnection = vi.fn();
const mockSendMessage = vi.fn();
const TOKEN = `123456789:${"A".repeat(35)}`;

vi.mock("../../src/engine/notify.js", () => ({
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
}));

vi.mock("../../src/db/store.js", () => ({
  loadConnections: () => mockLoadConnections(),
  createConnection: (...args: unknown[]) => mockCreateConnection(...args),
  getConnection: (id: unknown) => mockGetConnection(id),
  updateConnection: (...args: unknown[]) => mockUpdateConnection(...args),
  deleteConnection: (id: unknown) => mockDeleteConnection(id),
}));

vi.mock("@revolut/revolut-x-api", async (importOriginal) => {
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
      TOKEN,
      "--chat-id",
      "789",
    ]);
    expect(mockCreateConnection).toHaveBeenCalledWith(TOKEN, "789", "default");
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
      TOKEN,
      "--chat-id",
      "123",
      "--label",
      "alerts",
    ]);
    expect(mockCreateConnection).toHaveBeenCalledWith(TOKEN, "123", "alerts");
  });

  it("displays connection ID after adding", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "connector",
      "telegram",
      "add",
      "--token",
      TOKEN,
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
      TOKEN,
      "--chat-id",
      "789",
      "--json",
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    const parsed = JSON.parse(output);
    expect(parsed.id).toBe("conn-abc");
    expect(parsed.bot_token).not.toBe("123456:ABCDEFGHIJKLMNOP");
    expect(parsed.bot_token).toContain("****");
  });

  function add(...extra: string[]) {
    return program.parseAsync([
      "node",
      "revx",
      "connector",
      "telegram",
      "add",
      ...extra,
    ]);
  }

  it("refuses a token in the wrong format, saves nothing and never prints it", async () => {
    await expect(
      add("--token", "not-a-token-secret", "--chat-id", "789"),
    ).rejects.toThrow("process.exit");

    const errors = errSpy.mock.calls.flat().join(" ");
    expect(errors).toContain("--token doesn't look like a Telegram bot token");
    expect(errors).not.toContain("not-a-token-secret");
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });

  it("refuses a chat id in the wrong format", async () => {
    await expect(add("--token", TOKEN, "--chat-id", "my chat")).rejects.toThrow(
      "process.exit",
    );

    expect(errSpy.mock.calls.flat().join(" ")).toContain(
      '--chat-id must be a number such as 123456789 or -1001234567890, or a channel name such as @mychannel, got "my chat".',
    );
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });

  it.each(["0", "-0", "00012", "12345678901234567890"])(
    "refuses the chat id %s",
    async (chatId) => {
      await expect(add("--token", TOKEN, "--chat-id", chatId)).rejects.toThrow(
        "process.exit",
      );
      expect(mockCreateConnection).not.toHaveBeenCalled();
    },
  );

  it.each(["-1001234567890", "@alerts_channel"])(
    "accepts the chat id %s",
    async (chatId) => {
      await add("--token", TOKEN, "--chat-id", chatId);

      expect(mockCreateConnection).toHaveBeenCalledWith(
        TOKEN,
        chatId,
        "default",
      );
    },
  );

  it("saves nothing when the test message fails", async () => {
    mockSendMessage.mockResolvedValue({
      success: false,
      error: "HTTP 400: Bad Request: chat not found",
    });

    await expect(
      add("--token", TOKEN, "--chat-id", "789", "--test"),
    ).rejects.toThrow("process.exit");

    const errors = errSpy.mock.calls.flat().join(" ");
    expect(errors).toContain("chat not found");
    expect(errors).toContain("Nothing was saved.");
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });

  it("reads the saved connections before it sends a test", async () => {
    mockLoadConnections.mockImplementationOnce(() => {
      throw new Error("telegram.json can't be read (EACCES).");
    });

    await expect(
      add("--token", TOKEN, "--chat-id", "789", "--test"),
    ).rejects.toThrow("process.exit");

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });

  it("sends the test first and saves once it arrived", async () => {
    mockSendMessage.mockResolvedValue({ success: true });

    await add("--token", TOKEN, "--chat-id", "789", "--test");

    expect(mockSendMessage).toHaveBeenCalledWith(
      TOKEN,
      "789",
      "Test message from Revolut X CLI",
    );
    expect(mockCreateConnection).toHaveBeenCalledOnce();
    expect(mockSendMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateConnection.mock.invocationCallOrder[0],
    );
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

  it("shows when each connection was made in local time", async () => {
    mockLoadConnections.mockReturnValue([sampleConn]);
    await program.parseAsync(["node", "revx", "connector", "telegram", "list"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain(formatLocalDateTime(sampleConn.created_at));
    expect(output).toContain(LOCAL_TIME_NOTE);
    expect(output).not.toContain("2025-01-01T00:00:00");
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
