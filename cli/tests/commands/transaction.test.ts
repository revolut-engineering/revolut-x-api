import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerTransactionCommand } from "../../src/commands/transaction.js";

const mockGetTransactions = vi.fn();

vi.mock("../../src/util/client.js", () => ({
  getClient: vi.fn(() => ({
    getTransactions: mockGetTransactions,
  })),
}));

vi.mock("@revolut/revolut-x-api", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    RevolutXClient: vi.fn(),
    getConfigDir: () => "/tmp/revx-test",
    ensureConfigDir: () => {},
  };
});

vi.mock("../../src/util/parse.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/util/parse.js")>();
  return {
    ...actual,
    parseTimestamp: vi.fn(() => 1600000000000),
    parsePositiveInt: actual.parsePositiveInt,
  };
});

const sampleTransaction = {
  id: "a1b2c3d4-e5f6-7890-abcd-ef0123456789",
  status: "completed",
  type: "buy",
  source_currency: "USD",
  source_amount: "1000.00",
  destination_currency: "BTC",
  destination_amount: "0.01",
  created_date: 1700000000000,
  processed_date: 1700000001000,
};

function makeProgram() {
  const program = new Command().exitOverride();
  registerTransactionCommand(program);
  return program;
}

describe("transaction list", () => {
  let program: Command;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = makeProgram();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    mockGetTransactions.mockResolvedValue({ data: [sampleTransaction] });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("fetches transactions with date range", async () => {
    await program.parseAsync(["node", "revx", "transaction", "list"]);
    expect(mockGetTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: expect.any(Number),
        endDate: expect.any(Number),
      }),
    );
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain(sampleTransaction.id);
  });

  it("respects --limit by capping total results", async () => {
    const tx2 = {
      ...sampleTransaction,
      id: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
    };
    const tx3 = {
      ...sampleTransaction,
      id: "c3d4e5f6-a7b8-9012-cdef-234567890123",
    };
    mockGetTransactions.mockResolvedValue({
      data: [sampleTransaction, tx2, tx3],
      metadata: {},
    });
    await program.parseAsync([
      "node",
      "revx",
      "transaction",
      "list",
      "--limit",
      "2",
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain(sampleTransaction.id);
    expect(output).toContain(tx2.id);
    expect(output).not.toContain(tx3.id);
  });

  it("passes --start-date to API as lower bound", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "transaction",
      "list",
      "--start-date",
      "7d",
    ]);
    expect(mockGetTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: expect.any(Number) }),
    );
  });

  it("passes --types filter to API", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "transaction",
      "list",
      "--types",
      "buy,receive",
    ]);
    expect(mockGetTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        types: ["buy", "receive"],
      }),
    );
  });

  it("passes --statuses filter to API", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "transaction",
      "list",
      "--statuses",
      "completed,pending",
    ]);
    expect(mockGetTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        statuses: ["completed", "pending"],
      }),
    );
  });

  it("passes --currencies filter to API uppercased", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "transaction",
      "list",
      "--currencies",
      "btc,usd",
    ]);
    expect(mockGetTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        currencies: ["BTC", "USD"],
      }),
    );
  });

  it("exits with error on invalid type", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "transaction",
        "list",
        "--types",
        "invalid_type",
      ]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOutput = errSpy.mock.calls.flat().join(" ");
    expect(errOutput).toContain("Invalid types");
  });

  it("exits with error on invalid status", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "transaction",
        "list",
        "--statuses",
        "foobar",
      ]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOutput = errSpy.mock.calls.flat().join(" ");
    expect(errOutput).toContain("Invalid statuses");
  });

  it("shows empty message when no transactions found", async () => {
    mockGetTransactions.mockResolvedValue({ data: [] });
    await program.parseAsync(["node", "revx", "transaction", "list"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("No transactions found");
  });

  it("outputs JSON when --json is set", async () => {
    await program.parseAsync(["node", "revx", "transaction", "list", "--json"]);
    const output = logSpy.mock.calls.flat().join(" ");
    const parsed = JSON.parse(output);
    expect(parsed.data[0].id).toBe(sampleTransaction.id);
  });

  it("fetches all pages automatically within a date window", async () => {
    const tx2 = { ...sampleTransaction, id: "page2tx1" };
    mockGetTransactions
      .mockResolvedValueOnce({
        data: [sampleTransaction],
        metadata: { next_cursor: "cursor-xyz" },
      })
      .mockResolvedValueOnce({
        data: [tx2],
        metadata: {},
      });
    await program.parseAsync(["node", "revx", "transaction", "list"]);
    expect(mockGetTransactions).toHaveBeenCalledTimes(2);
    expect(mockGetTransactions).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: "cursor-xyz" }),
    );
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain(sampleTransaction.id);
    expect(output).toContain("page2tx1");
  });

  it("displays a signed source amount", async () => {
    await program.parseAsync(["node", "revx", "transaction", "list"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("Source Amount");
    expect(output).toContain("-1000.00 USD");
  });

  it("displays a signed destination amount", async () => {
    await program.parseAsync(["node", "revx", "transaction", "list"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("Destination Amount");
    expect(output).toContain("+0.01 BTC");
  });

  it("handles a destination-only transaction", async () => {
    const receiveTransaction = {
      ...sampleTransaction,
      type: "receive",
      source_currency: undefined,
      source_amount: undefined,
      destination_currency: "USD",
      destination_amount: "14.70",
    };
    mockGetTransactions.mockResolvedValue({ data: [receiveTransaction] });
    await program.parseAsync(["node", "revx", "transaction", "list"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("+14.70 USD");
    expect(output).not.toContain("-14.70 USD");
  });

  it("handles a source-only transaction", async () => {
    const sendTransaction = {
      ...sampleTransaction,
      type: "send",
      source_currency: "BTC",
      source_amount: "0.005",
      destination_currency: undefined,
      destination_amount: undefined,
    };
    mockGetTransactions.mockResolvedValue({ data: [sendTransaction] });
    await program.parseAsync(["node", "revx", "transaction", "list"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("-0.005 BTC");
    expect(output).not.toContain("+0.005 BTC");
  });

  it("handles missing processed_date gracefully", async () => {
    const txPending = {
      ...sampleTransaction,
      status: "pending",
      processed_date: undefined,
    };
    mockGetTransactions.mockResolvedValue({ data: [txPending] });
    await program.parseAsync(["node", "revx", "transaction", "list"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("pending");
  });

  it("passes all filters combined", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "transaction",
      "list",
      "--start-date",
      "7d",
      "--types",
      "buy",
      "--statuses",
      "completed",
      "--currencies",
      "BTC",
      "--limit",
      "50",
    ]);
    expect(mockGetTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        types: ["buy"],
        statuses: ["completed"],
        currencies: ["BTC"],
        cursor: undefined,
        limit: expect.any(Number),
      }),
    );
  });
});
