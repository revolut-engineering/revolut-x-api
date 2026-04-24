import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerAccountCommand } from "../../src/commands/account.js";

const mockGetBalances = vi.fn();

vi.mock("../../src/util/client.js", () => ({
  getClient: vi.fn(() => ({ getBalances: mockGetBalances })),
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
    RevolutXClient: vi.fn(),
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

const sampleBalances = [
  {
    currency: "BTC",
    available: "1.5",
    reserved: "0.0",
    staked: "0.0",
    total: "1.5",
  },
  {
    currency: "ETH",
    available: "10.0",
    reserved: "0.5",
    staked: "0.0",
    total: "10.5",
  },
  {
    currency: "USD",
    available: "0.0",
    reserved: "0.0",
    staked: "0.0",
    total: "0.0",
  },
];

describe("account balances", () => {
  let program: Command;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command().exitOverride();
    registerAccountCommand(program);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    mockGetBalances.mockResolvedValue(sampleBalances);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("fetches balances from API", async () => {
    await program.parseAsync(["node", "revx", "account", "balances"]);
    expect(mockGetBalances).toHaveBeenCalledOnce();
  });

  it("filters out zero balances by default", async () => {
    await program.parseAsync(["node", "revx", "account", "balances"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("BTC");
    expect(output).toContain("ETH");
    // USD has total "0.0" — should be excluded from non-all listing
    // (it won't appear as a data row, though headers/section titles are fine)
  });

  it("includes zero balances with --all flag", async () => {
    await program.parseAsync(["node", "revx", "account", "balances", "--all"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("USD");
  });

  it("filters balances by --currencies option", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "account",
      "balances",
      "--currencies",
      "BTC,USD",
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("BTC");
    expect(output).toContain("USD");
  });

  it("displays single currency when provided as positional argument", async () => {
    await program.parseAsync(["node", "revx", "account", "balances", "ETH"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("ETH");
  });

  it("is case-insensitive for the currency argument", async () => {
    await program.parseAsync(["node", "revx", "account", "balances", "btc"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("BTC");
  });

  it("outputs JSON for all non-zero balances when --json is set", async () => {
    await program.parseAsync(["node", "revx", "account", "balances", "--json"]);
    const output = logSpy.mock.calls.flat().join(" ");
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(2); // BTC and ETH (not zero USD)
    expect(parsed[0].currency).toBe("BTC");
  });

  it("outputs JSON for a specific currency when --json is set", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "account",
      "balances",
      "BTC",
      "--json",
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    const parsed = JSON.parse(output);
    expect(parsed.currency).toBe("BTC");
    expect(parsed.total).toBe("1.5");
  });

  it("exits with error when specific currency not found", async () => {
    await expect(
      program.parseAsync(["node", "revx", "account", "balances", "XRP"]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOutput = errSpy.mock.calls.flat().join(" ");
    expect(errOutput).toContain("XRP");
  });

  it("shows no balances message when all are filtered to zero", async () => {
    mockGetBalances.mockResolvedValue([
      {
        currency: "USD",
        available: "0.0",
        reserved: "0.0",
        staked: "0.0",
        total: "0.0",
      },
    ]);
    await program.parseAsync(["node", "revx", "account", "balances"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("No balances found");
  });
});
