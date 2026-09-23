import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerTransactionCommand } from "../../src/commands/transaction.js";

const mockGetTransactions = vi.fn();
const mockGetTransaction = vi.fn();

vi.mock("../../src/util/client.js", () => ({
  getClient: vi.fn(() => ({
    getTransactions: mockGetTransactions,
    getTransaction: mockGetTransaction,
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
  source: {
    amount: "1000.00",
    currency: "USD",
  },
  destination: {
    amount: "0.01",
    currency: "BTC",
  },
  created_date: 1700000000000,
  processed_date: 1700000001000,
};

const sampleTransactionDetails = {
  id: "a1b2c3d4-e5f6-7890-abcd-ef0123456789",
  status: "completed",
  type: "buy",
  source: {
    amount: "1000.00",
    currency: "USD",
    fee: "1.00",
    fee_currency: "USD",
    account: {
      type: "revolut_x",
      display_name: "Crypto Primary",
    },
  },
  destination: {
    amount: "0.01",
    currency: "BTC",
    account: {
      type: "revolut_x",
      display_name: "Crypto Primary",
    },
  },
  order_id: "order-123",
  description: "Test transaction",
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
      "BUY,SELL,RECEIVE,SEND,STAKE,UN_STAKE,REWARD",
    ]);
    expect(mockGetTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        types: [
          "buy",
          "sell",
          "receive",
          "send",
          "stake",
          "un_stake",
          "reward",
        ],
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
      "completed,cancelled",
    ]);
    expect(mockGetTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        statuses: ["completed", "cancelled"],
      }),
    );
  });

  it("rejects the US spelling canceled for --statuses", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "transaction",
        "list",
        "--statuses",
        "canceled",
      ]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOutput = errSpy.mock.calls.flat().join(" ");
    expect(errOutput).toContain("Invalid statuses");
    expect(errOutput).toContain("cancelled");
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

  it("includes per-leg account types in JSON output", async () => {
    const buyTransaction = {
      ...sampleTransaction,
      source: {
        amount: "1000.00",
        currency: "USD",
        account: { type: "revolut" },
      },
      destination: {
        amount: "0.01",
        currency: "BTC",
        account: { type: "revolut_x" },
      },
    };
    mockGetTransactions.mockResolvedValue({ data: [buyTransaction] });
    await program.parseAsync(["node", "revx", "transaction", "list", "--json"]);
    const output = logSpy.mock.calls.flat().join(" ");
    const parsed = JSON.parse(output);
    expect(parsed.data[0].source.account.type).toBe("revolut");
    expect(parsed.data[0].destination.account.type).toBe("revolut_x");
  });

  it("omits per-leg account types from the list table", async () => {
    const buyTransaction = {
      ...sampleTransaction,
      source: {
        amount: "1000.00",
        currency: "USD",
        account: { type: "revolut" },
      },
      destination: {
        amount: "0.01",
        currency: "BTC",
        account: { type: "revolut_x" },
      },
    };
    mockGetTransactions.mockResolvedValue({ data: [buyTransaction] });
    await program.parseAsync(["node", "revx", "transaction", "list"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("-1000.00 USD");
    expect(output).toContain("+0.01 BTC");
    expect(output).not.toContain("(revolut)");
    expect(output).not.toContain("(revolut_x)");
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
      source: undefined,
      destination: { amount: "14.70", currency: "USD" },
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
      source: { amount: "0.005", currency: "BTC" },
      destination: undefined,
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

describe("transaction get", () => {
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
    mockGetTransaction.mockResolvedValue(sampleTransactionDetails);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("fetches the transaction by id", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "transaction",
      "get",
      sampleTransactionDetails.id,
    ]);
    expect(mockGetTransaction).toHaveBeenCalledWith(
      sampleTransactionDetails.id,
    );
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain(sampleTransactionDetails.id);
  });

  it("shows leg amounts, fees, and account details", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "transaction",
      "get",
      sampleTransactionDetails.id,
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("1000.00 USD");
    expect(output).toContain("0.01 BTC");
    expect(output).toContain("1.00 USD");
    expect(output).toContain("Crypto Primary");
    expect(output).toContain("revolut_x");
  });

  it("shows only the source leg for a stake", async () => {
    mockGetTransaction.mockResolvedValue({
      ...sampleTransactionDetails,
      type: "stake",
      source: {
        amount: "0.01",
        currency: "BTC",
        account: {
          type: "revolut_x",
          display_name: "Crypto Primary",
        },
      },
      destination: undefined,
    });
    await program.parseAsync([
      "node",
      "revx",
      "transaction",
      "get",
      sampleTransactionDetails.id,
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("Crypto Primary · revolut_x");
    expect(output).not.toContain("Destination");
  });

  it("shows a sub-account as the leg account", async () => {
    mockGetTransaction.mockResolvedValue({
      ...sampleTransactionDetails,
      type: "send",
      destination: {
        amount: "0.01",
        currency: "BTC",
        account: {
          type: "revolut_x",
          display_name: "My X Account",
        },
      },
    });
    await program.parseAsync([
      "node",
      "revx",
      "transaction",
      "get",
      sampleTransactionDetails.id,
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("My X Account · revolut_x");
  });

  it("shows optional detail fields when present", async () => {
    mockGetTransaction.mockResolvedValue({
      ...sampleTransactionDetails,
      type: "receive",
      source: {
        amount: "0.01",
        currency: "BTC",
        account: {
          type: "external_crypto",
          crypto_address: "bc1qsourcewallet",
        },
      },
      crypto_transaction_hash: "0xabc123",
      network: "Ethereum",
      order_id: undefined,
    });
    await program.parseAsync([
      "node",
      "revx",
      "transaction",
      "get",
      sampleTransactionDetails.id,
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("Test transaction");
    expect(output).toContain("0xabc123");
    expect(output).toContain("Ethereum");
    expect(output).toContain("external_crypto · bc1qsourcewallet");
    expect(output).not.toContain("Order ID");
  });

  it("omits missing optional fields", async () => {
    mockGetTransaction.mockResolvedValue({
      id: sampleTransactionDetails.id,
      status: "pending",
      type: "send",
      source: { amount: "0.01", currency: "BTC" },
      created_date: 1700000000000,
    });
    await program.parseAsync([
      "node",
      "revx",
      "transaction",
      "get",
      sampleTransactionDetails.id,
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).not.toContain("Description");
    expect(output).not.toContain("Order ID");
    expect(output).not.toContain("Network");
    expect(output).not.toContain("Processed");
  });

  it("outputs JSON when --json is set", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "transaction",
      "get",
      sampleTransactionDetails.id,
      "--json",
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    const parsed = JSON.parse(output);
    expect(parsed.id).toBe(sampleTransactionDetails.id);
    expect(parsed.source.fee).toBe("1.00");
  });

  it("exits with error when the transaction is not found", async () => {
    mockGetTransaction.mockRejectedValue(
      new Error("Not Found (404): Transaction not found"),
    );
    await expect(
      program.parseAsync(["node", "revx", "transaction", "get", "missing-id"]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOutput = errSpy.mock.calls.flat().join(" ");
    expect(errOutput).toContain("Transaction not found");
  });
});
