import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerOrderCommand } from "../../src/commands/order.js";
import { formatLocalDateTime } from "../../src/output/formatter.js";
import {
  BadRequestError,
  NetworkError,
  ServerError,
} from "@revolut/revolut-x-api";

const mockPlaceOrder = vi.fn();
const mockGetActiveOrders = vi.fn();
const mockGetHistoricalOrders = vi.fn();
const mockGetOrder = vi.fn();
const mockCancelOrder = vi.fn();
const mockCancelAllOrders = vi.fn();
const mockGetOrderFills = vi.fn();
const mockReplaceOrder = vi.fn();
const mockGetCurrencyPairs = vi.fn(async () => ({
  "BTC/USD": {
    base: "BTC",
    quote: "USD",
    base_step: "0.00000001",
    quote_step: "0.01",
    min_order_size: "0.00001",
    max_order_size: "1000",
    min_order_size_quote: "1",
    slippage: 0.01,
    status: "active",
  },
}));

vi.mock("../../src/util/client.js", () => ({
  getClient: vi.fn(() => ({
    placeOrder: mockPlaceOrder,
    getActiveOrders: mockGetActiveOrders,
    getHistoricalOrders: mockGetHistoricalOrders,
    getOrder: mockGetOrder,
    cancelOrder: mockCancelOrder,
    cancelAllOrders: mockCancelAllOrders,
    getOrderFills: mockGetOrderFills,
    replaceOrder: mockReplaceOrder,
    getCurrencyPairs: mockGetCurrencyPairs,
  })),
}));

vi.mock("@revolut/revolut-x-api", async (importOriginal) => {
  const actual = await importOriginal();
  class RevolutXError extends Error {}
  class AuthNotConfiguredError extends RevolutXError {}
  class AuthenticationError extends RevolutXError {}
  class RateLimitError extends RevolutXError {}
  class BadRequestError extends RevolutXError {}
  class NotFoundError extends RevolutXError {}
  class NetworkError extends RevolutXError {
    readonly mayHaveReachedServer: boolean;
    constructor(message: string, options?: { mayHaveReachedServer?: boolean }) {
      super(message);
      this.mayHaveReachedServer = options?.mayHaveReachedServer ?? true;
    }
  }
  class ServerError extends RevolutXError {
    constructor(
      message: string,
      readonly statusCode: number,
    ) {
      super(message);
    }
  }
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
    ServerError,
    isDuplicateClientOrderIdError: (err: unknown) =>
      err instanceof BadRequestError &&
      /already been placed/i.test((err as Error).message),
  };
});

const sampleOrder = {
  id: "order-123",
  client_order_id: "client-123",
  symbol: "BTC-USD",
  side: "buy",
  type: "limit",
  quantity: "0.001",
  filled_quantity: "0.0",
  leaves_quantity: "0.001",
  price: "95000",
  average_fill_price: null,
  status: "new",
  reject_reason: null,
  time_in_force: "gtc",
  execution_instructions: [],
  created_date: 1700000000000,
  updated_date: 1700000000000,
  previous_order_id: null,
  conditional: null,
  take_profit: null,
  stop_loss: null,
};

const sampleTwapOrder = {
  id: "twap-order-456",
  client_order_id: "twap-order-456",
  symbol: "BTC-USD",
  side: "buy",
  type: "twap",
  quantity: "0.1",
  filled_quantity: "0.01",
  leaves_quantity: "0.09",
  amount: "6000",
  filled_amount: "600",
  price: "0",
  status: "partially_filled",
  time_in_force: "gtc",
  execution_instructions: [],
  twap: {
    type: "market",
    period: 300,
    frequency: 30,
    total_slices: 10,
    completed_slices: 1,
    start_date: 1783067249312,
    end_date: 1783067549312,
  },
  created_date: 1783067249312,
  updated_date: 1783067279312,
  conditional: null,
  take_profit: null,
  stop_loss: null,
};

afterEach(() => {
  process.exitCode = undefined;
});

function makeProgram() {
  const program = new Command().exitOverride();
  registerOrderCommand(program);
  return program;
}

describe("order place", () => {
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
    mockPlaceOrder.mockResolvedValue({
      data: {
        venue_order_id: "v-abc",
        client_order_id: "c-abc",
        state: "pending_new",
      },
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("names --qty when it is zero and sends nothing", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "place",
        "BTC-USD",
        "buy",
        "--qty",
        "0",
        "--market",
      ]),
    ).rejects.toThrow("process.exit");

    expect(errSpy.mock.calls.flat().join(" ")).toContain(
      '--qty must be greater than 0, got "0".',
    );
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it("refuses a limit price off the price step before sending", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "place",
        "BTC-USD",
        "buy",
        "--qty",
        "0.001",
        "--limit",
        "95000.015",
      ]),
    ).rejects.toThrow("process.exit");

    expect(errSpy.mock.calls.flat().join(" ")).toContain(
      "The nearest valid prices are 95000.01 and 95000.02.",
    );
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it("reads no pair rules for a market order", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "place",
      "BTC-USD",
      "buy",
      "--qty",
      "0.001",
      "--market",
    ]);

    expect(mockGetCurrencyPairs).not.toHaveBeenCalled();
    expect(mockPlaceOrder).toHaveBeenCalledOnce();
  });

  it("names a pair Revolut X doesn't have and sends nothing", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "place",
        "NOPE-USD",
        "buy",
        "--qty",
        "1",
        "--limit",
        "1",
      ]),
    ).rejects.toThrow("process.exit");

    expect(errSpy.mock.calls.flat().join(" ")).toContain(
      "NOPE-USD is not a pair on Revolut X. See: revx market pairs",
    );
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it("says the order was not sent when the pair rules can't be read", async () => {
    mockGetCurrencyPairs.mockRejectedValueOnce(
      new Error("Service unavailable"),
    );

    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "place",
        "BTC-USD",
        "buy",
        "--qty",
        "0.001",
        "--limit",
        "95000",
      ]),
    ).rejects.toThrow("process.exit");

    expect(errSpy.mock.calls.flat().join(" ")).toContain(
      "Could not read the BTC-USD price step, so the order was not sent. Service unavailable",
    );
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it("refuses a blank --client-order-id", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "place",
        "BTC-USD",
        "buy",
        "--qty",
        "0.001",
        "--market",
        "--client-order-id",
        " ",
      ]),
    ).rejects.toThrow("process.exit");

    expect(errSpy.mock.calls.flat().join(" ")).toContain(
      "--client-order-id must not be empty.",
    );
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it("checks the pair format before reading any pair rules", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "place",
        "btc/usd",
        "buy",
        "--qty",
        "0.001",
        "--limit",
        "95000",
      ]),
    ).rejects.toThrow("process.exit");

    expect(errSpy.mock.calls.flat().join(" ")).toContain(
      'The pair must look like BTC-USD, got "btc/usd".',
    );
    expect(mockGetCurrencyPairs).not.toHaveBeenCalled();
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it("accepts a lowercase pair", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "place",
      "btc-usd",
      "buy",
      "--qty",
      "0.001",
      "--market",
    ]);

    expect(mockPlaceOrder).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "BTC-USD" }),
    );
  });

  it("refuses an empty --limit instead of ignoring it", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "place",
        "BTC-USD",
        "buy",
        "--qty",
        "1",
        "--limit",
        "",
      ]),
    ).rejects.toThrow("process.exit");

    expect(errSpy.mock.calls.flat().join(" ")).toContain(
      '--limit must be a positive number, got "".',
    );
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it("sends a number written with an exponent in plain form", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "place",
      "BTC-USD",
      "buy",
      "--qty",
      "1e-3",
      "--limit",
      "95000",
    ]);

    expect(mockPlaceOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: expect.objectContaining({ baseSize: "0.001", price: "95000" }),
      }),
    );
  });

  it("places a market buy order with base quantity", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "place",
      "BTC-USD",
      "buy",
      "--qty",
      "0.001",
      "--market",
    ]);
    expect(mockPlaceOrder).toHaveBeenCalledWith({
      clientOrderId: expect.any(String),
      symbol: "BTC-USD",
      side: "buy",
      market: { baseSize: "0.001" },
    });
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("v-abc");
  });

  it("places a limit sell order", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "place",
      "BTC-USD",
      "sell",
      "--qty",
      "0.001",
      "--limit",
      "100000",
    ]);
    expect(mockPlaceOrder).toHaveBeenCalledWith({
      clientOrderId: expect.any(String),
      symbol: "BTC-USD",
      side: "sell",
      limit: { price: "100000", baseSize: "0.001" },
    });
  });

  it("places a limit order with --time-in-force", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "place",
      "BTC-USD",
      "buy",
      "--qty",
      "0.001",
      "--limit",
      "95000",
      "--time-in-force",
      "ioc",
    ]);
    expect(mockPlaceOrder).toHaveBeenCalledWith({
      clientOrderId: expect.any(String),
      symbol: "BTC-USD",
      side: "buy",
      limit: { price: "95000", baseSize: "0.001", timeInForce: "ioc" },
    });
  });

  it("passes through --client-order-id", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "place",
      "BTC-USD",
      "buy",
      "--qty",
      "0.001",
      "--limit",
      "95000",
      "--client-order-id",
      "11111111-2222-3333-4444-555555555555",
    ]);
    expect(mockPlaceOrder).toHaveBeenCalledWith({
      symbol: "BTC-USD",
      side: "buy",
      clientOrderId: "11111111-2222-3333-4444-555555555555",
      limit: { price: "95000", baseSize: "0.001" },
    });
  });

  it("rejects --market combined with --limit", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "place",
        "BTC-USD",
        "buy",
        "--qty",
        "0.001",
        "--market",
        "--limit",
        "95000",
      ]),
    ).rejects.toThrow("process.exit");
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    const output = errSpy.mock.calls.flat().join(" ");
    expect(output).toContain("not both");
  });

  it("rejects --time-in-force combined with --market", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "place",
        "BTC-USD",
        "buy",
        "--qty",
        "0.001",
        "--market",
        "--time-in-force",
        "ioc",
      ]),
    ).rejects.toThrow("process.exit");
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    const output = errSpy.mock.calls.flat().join(" ");
    expect(output).toContain("--time-in-force applies to limit orders only");
  });

  it("rejects --post-only combined with --market", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "place",
        "BTC-USD",
        "buy",
        "--qty",
        "0.001",
        "--market",
        "--post-only",
      ]),
    ).rejects.toThrow("process.exit");
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    const output = errSpy.mock.calls.flat().join(" ");
    expect(output).toContain("--post-only applies to limit orders only");
  });

  it("pluralises the error when both limit-only flags are used with --market", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "place",
        "BTC-USD",
        "buy",
        "--qty",
        "0.001",
        "--market",
        "--post-only",
        "--time-in-force",
        "gtc",
      ]),
    ).rejects.toThrow("process.exit");
    const output = errSpy.mock.calls.flat().join(" ");
    expect(output).toContain(
      "--time-in-force and --post-only apply to limit orders only",
    );
  });

  it("rejects --post-only combined with --time-in-force ioc", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "place",
        "BTC-USD",
        "buy",
        "--qty",
        "0.001",
        "--limit",
        "95000",
        "--post-only",
        "--time-in-force",
        "ioc",
      ]),
    ).rejects.toThrow("process.exit");
    expect(mockPlaceOrder).not.toHaveBeenCalled();
    const output = errSpy.mock.calls.flat().join(" ");
    expect(output).toContain("--post-only cannot be combined");
  });

  it("rejects an unsupported --time-in-force value", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "place",
        "BTC-USD",
        "buy",
        "--qty",
        "0.001",
        "--limit",
        "95000",
        "--time-in-force",
        "fok",
      ]),
    ).rejects.toThrow(/Allowed choices are gtc, ioc/);
    expect(mockPlaceOrder).not.toHaveBeenCalled();
  });

  it("places a market buy order with quote amount", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "place",
      "BTC-USD",
      "buy",
      "--quote",
      "500",
      "--market",
    ]);
    expect(mockPlaceOrder).toHaveBeenCalledWith({
      clientOrderId: expect.any(String),
      symbol: "BTC-USD",
      side: "buy",
      market: { quoteSize: "500" },
    });
  });

  it("normalizes symbol to uppercase", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "place",
      "btc-usd",
      "buy",
      "--qty",
      "0.001",
      "--market",
    ]);
    expect(mockPlaceOrder).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "BTC-USD" }),
    );
  });

  it("outputs JSON when --json is set", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "place",
      "BTC-USD",
      "buy",
      "--qty",
      "0.001",
      "--market",
      "--json",
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    const parsed = JSON.parse(output);
    expect(parsed.data.venue_order_id).toBe("v-abc");
  });

  function placeArgs(...extra: string[]) {
    return ["node", "revx", "order", "place", "BTC-USD", "buy", ...extra];
  }

  function answer(state: string) {
    mockPlaceOrder.mockResolvedValue({
      data: { venue_order_id: "v-abc", client_order_id: "c-abc", state },
    });
  }

  it("reports a placed order as placed and leaves the exit code alone", async () => {
    answer("new");

    await program.parseAsync(placeArgs("--qty", "0.001", "--limit", "90000"));

    expect(logSpy.mock.calls.flat().join(" ")).toContain("✓ Order placed.");
    expect(process.exitCode).toBeUndefined();
  });

  it("reports a rejected order as an error on stderr and exits 1", async () => {
    answer("rejected");

    await program.parseAsync(placeArgs("--qty", "0.001", "--limit", "90000"));

    const errors = errSpy.mock.calls.flat().join(" ");
    expect(errors).toContain("The exchange rejected the order.");
    expect(errors).toContain("v-abc");
    expect(errors).toContain(
      "See why in a few seconds with: revx order get v-abc",
    );
    expect(logSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("names the usual cause of a rejected post-only order", async () => {
    answer("rejected");

    await program.parseAsync(
      placeArgs("--qty", "0.001", "--limit", "90000", "--post-only"),
    );

    expect(errSpy.mock.calls.flat().join(" ")).toContain(
      "A post-only order is usually rejected because its price would trade at once.",
    );
  });

  it("keeps the JSON document of a rejected order, gives the reason on stderr and exits 1", async () => {
    answer("rejected");

    await program.parseAsync(
      placeArgs("--qty", "0.001", "--limit", "90000", "--json"),
    );

    expect(JSON.parse(logSpy.mock.calls.flat().join(" "))).toEqual({
      data: {
        venue_order_id: "v-abc",
        client_order_id: "c-abc",
        state: "rejected",
      },
    });
    expect(errSpy.mock.calls.flat().join(" ")).toContain(
      "The exchange rejected the order.",
    );
    expect(process.exitCode).toBe(1);
  });

  it("warns, without failing, when an IOC limit order closed at once", async () => {
    answer("cancelled");

    await program.parseAsync(
      placeArgs("--qty", "0.001", "--limit", "90000", "--time-in-force", "ioc"),
    );

    expect(logSpy.mock.calls.flat().join(" ")).toContain(
      "Order closed at once.",
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("says an order whose reply was lost may have been placed, and how to retry safely", async () => {
    mockPlaceOrder.mockRejectedValue(
      new NetworkError("No reply from the exchange: UND_ERR_SOCKET.", {
        mayHaveReachedServer: true,
      }),
    );

    await program.parseAsync(placeArgs("--qty", "0.001", "--limit", "90000"));

    const sentId = mockPlaceOrder.mock.calls[0][0].clientOrderId as string;
    const errors = errSpy.mock.calls.flat().join("\n");
    expect(sentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(errors).toContain(
      "No reply from the exchange: UND_ERR_SOCKET. The order may have been placed.",
    );
    expect(errors).toContain(`Client order ID: ${sentId}`);
    expect(errors).toContain(`--client-order-id ${sentId}`);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("treats a server error after retries as maybe placed", async () => {
    mockPlaceOrder.mockRejectedValue(new ServerError("Internal error", 503));

    await program.parseAsync(placeArgs("--qty", "0.001", "--limit", "90000"));

    expect(errSpy.mock.calls.flat().join("\n")).toContain(
      "The exchange answered with a server error (503). The order may have been placed.",
    );
    expect(process.exitCode).toBe(1);
  });

  it("says no second order was placed when a chosen id already exists", async () => {
    mockPlaceOrder.mockRejectedValue(
      new BadRequestError(
        "An order with the client_order_id 'c-mine' has already been placed",
      ),
    );

    await program.parseAsync(
      placeArgs(
        "--qty",
        "0.001",
        "--limit",
        "90000",
        "--client-order-id",
        "c-mine",
      ),
    );

    const errors = errSpy.mock.calls.flat().join("\n");
    expect(errors).toContain(
      "An order with client order ID c-mine already exists, so no second one was placed.",
    );
    expect(errors).not.toContain("--client-order-id c-mine.");
    expect(process.exitCode).toBe(1);
  });

  it("keeps the plain network error when the request never reached the exchange", async () => {
    mockPlaceOrder.mockRejectedValue(
      new NetworkError("Could not reach the exchange: ECONNREFUSED.", {
        mayHaveReachedServer: false,
      }),
    );

    await expect(
      program.parseAsync(placeArgs("--qty", "0.001", "--limit", "90000")),
    ).rejects.toThrow("process.exit");

    const errors = errSpy.mock.calls.flat().join("\n");
    expect(errors).toContain("Could not reach the exchange: ECONNREFUSED.");
    expect(errors).not.toContain("may have been placed");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("leaves the exit code to the error handler when the request itself fails", async () => {
    mockPlaceOrder.mockRejectedValue(new Error("Insufficient balance"));

    await expect(
      program.parseAsync(placeArgs("--qty", "0.001", "--limit", "90000")),
    ).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.flat().join(" ")).toContain(
      "Insufficient balance",
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("warns, without failing, when a market order closed at once", async () => {
    answer("cancelled");

    await program.parseAsync(placeArgs("--qty", "0.001", "--market"));

    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("Order closed at once.");
    expect(output).toContain(
      "See what filled in a few seconds with: revx order fills v-abc",
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("fails when the exchange cancelled a resting order at once", async () => {
    answer("cancelled");

    await program.parseAsync(placeArgs("--qty", "0.001", "--limit", "90000"));

    expect(errSpy.mock.calls.flat().join(" ")).toContain(
      "The exchange cancelled the order at once.",
    );
    expect(process.exitCode).toBe(1);
  });

  it("exits with error for invalid side", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "place",
        "BTC-USD",
        "sideways",
        "--qty",
        "0.001",
        "--market",
      ]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOutput = errSpy.mock.calls.flat().join(" ");
    expect(errOutput).toContain("buy");
  });

  it("exits with error when neither --qty nor --quote is provided", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "place",
        "BTC-USD",
        "buy",
        "--market",
      ]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with error when both --qty and --quote are provided", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "place",
        "BTC-USD",
        "buy",
        "--qty",
        "0.001",
        "--quote",
        "500",
        "--market",
      ]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with error when neither --limit nor --market is specified", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "place",
        "BTC-USD",
        "buy",
        "--qty",
        "0.001",
      ]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("order open", () => {
  let program: Command;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = makeProgram();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    mockGetActiveOrders.mockResolvedValue({ data: [sampleOrder] });
  });

  afterEach(() => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("lists open orders", async () => {
    await program.parseAsync(["node", "revx", "order", "open"]);
    expect(mockGetActiveOrders).toHaveBeenCalledWith({});
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("BTC-USD");
  });

  it("filters by --symbols option", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "open",
      "--symbols",
      "BTC-USD,ETH-USD",
    ]);
    expect(mockGetActiveOrders).toHaveBeenCalledWith(
      expect.objectContaining({ symbols: ["BTC-USD", "ETH-USD"] }),
    );
  });

  it("passes advanced filter options to API", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "open",
      "--order-states",
      "new,partially_filled",
      "--order-types",
      "limit,conditional",
      "--side",
      "buy",
      "--limit",
      "10",
    ]);
    expect(mockGetActiveOrders).toHaveBeenCalledWith(
      expect.objectContaining({
        orderStates: ["new", "partially_filled"],
        orderTypes: ["limit", "conditional"],
        side: "buy",
        limit: 10,
      }),
    );
  });

  it("formats partially_filled open orders correctly", async () => {
    mockGetActiveOrders.mockResolvedValue({
      data: [
        {
          ...sampleOrder,
          status: "partially_filled",
          filled_quantity: "0.0005",
        },
      ],
    });
    await program.parseAsync(["node", "revx", "order", "open"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("partially_filled");
  });

  it("displays avg fill price for partially_filled open orders", async () => {
    mockGetActiveOrders.mockResolvedValue({
      data: [
        {
          ...sampleOrder,
          status: "partially_filled",
          filled_quantity: "0.0005",
          average_fill_price: "94500",
        },
      ],
    });
    await program.parseAsync(["node", "revx", "order", "open"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("Avg Fill Price");
    expect(output).toContain("94500");
  });

  it("displays twap conditions for twap open orders", async () => {
    mockGetActiveOrders.mockResolvedValue({ data: [sampleTwapOrder] });
    await program.parseAsync(["node", "revx", "order", "open"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("TWAP");
    expect(output).toContain("300s/30s");
    expect(output).toContain("1/10 slices");
  });

  it("shows empty message when no open orders", async () => {
    mockGetActiveOrders.mockResolvedValue({ data: [] });
    await program.parseAsync(["node", "revx", "order", "open"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("No open orders found");
  });

  it("outputs JSON when --json is set", async () => {
    await program.parseAsync(["node", "revx", "order", "open", "--json"]);
    const output = logSpy.mock.calls.flat().join(" ");
    const parsed = JSON.parse(output);
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0].symbol).toBe("BTC-USD");
  });

  it("displays created timestamp in the output", async () => {
    await program.parseAsync(["node", "revx", "order", "open"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain(formatLocalDateTime(1700000000000));
  });
});

describe("order history", () => {
  let program: Command;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = makeProgram();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    mockGetHistoricalOrders.mockResolvedValue({
      data: [{ ...sampleOrder, status: "filled" }],
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("lists historical orders", async () => {
    await program.parseAsync(["node", "revx", "order", "history"]);
    expect(mockGetHistoricalOrders).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: expect.any(Number),
        endDate: expect.any(Number),
      }),
    );
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("BTC-USD");
    expect(output).toContain("Period: Default / Recent");
  });

  it("passes --symbols filter to API", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "history",
      "--symbols",
      "BTC-USD",
    ]);
    expect(mockGetHistoricalOrders).toHaveBeenCalledWith(
      expect.objectContaining({ symbols: ["BTC-USD"] }),
    );
  });

  it("passes advanced filter options including partially_filled, types, and date ranges to API", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "history",
      "--order-states",
      "filled,cancelled,partially_filled",
      "--order-types",
      "market,limit",
      "--start-date",
      "1715000000000",
      "--end-date",
      "1715086400000",
    ]);
    expect(mockGetHistoricalOrders).toHaveBeenCalledWith(
      expect.objectContaining({
        orderStates: ["filled", "cancelled", "partially_filled"],
        orderTypes: ["market", "limit"],
        startDate: expect.any(Number),
      }),
    );
  });

  it("passes conditional and tpsl order types filter", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "history",
      "--order-types",
      "conditional,tpsl",
    ]);
    expect(mockGetHistoricalOrders).toHaveBeenCalledWith(
      expect.objectContaining({
        orderTypes: ["conditional", "tpsl"],
      }),
    );
  });

  it("passes twap order type filter", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "history",
      "--order-types",
      "twap",
    ]);
    expect(mockGetHistoricalOrders).toHaveBeenCalledWith(
      expect.objectContaining({
        orderTypes: ["twap"],
      }),
    );
  });

  it("displays twap conditions for twap historical orders", async () => {
    mockGetHistoricalOrders.mockResolvedValue({
      data: [{ ...sampleTwapOrder, status: "filled" }],
    });
    await program.parseAsync(["node", "revx", "order", "history"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("TWAP");
    expect(output).toContain("300s/30s");
    expect(output).toContain("1/10 slices");
  });

  it("displays conditions column for historical orders with triggers", async () => {
    mockGetHistoricalOrders.mockResolvedValue({
      data: [
        {
          ...sampleOrder,
          status: "filled",
          type: "tpsl",
          take_profit: {
            trigger_price: "100000",
            type: "market",
            trigger_direction: "ge",
            time_in_force: "gtc",
            execution_instructions: [],
          },
          stop_loss: {
            trigger_price: "80000",
            type: "market",
            trigger_direction: "le",
            time_in_force: "gtc",
            execution_instructions: [],
          },
        },
      ],
    });
    await program.parseAsync(["node", "revx", "order", "history"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("TP 100000");
    expect(output).toContain("SL 80000");
  });

  it("displays period subtitle in header when date ranges are provided", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "history",
      "--start-date",
      "1700000000000",
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("Period: Since");
  });

  it("formats partially_filled historical orders correctly", async () => {
    mockGetHistoricalOrders.mockResolvedValue({
      data: [
        {
          ...sampleOrder,
          status: "partially_filled",
          filled_quantity: "0.0005",
        },
      ],
    });
    await program.parseAsync(["node", "revx", "order", "history"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("partially_filled");
    expect(output).toContain("0.0005");
  });

  it("displays avg fill price for partially_filled historical orders", async () => {
    mockGetHistoricalOrders.mockResolvedValue({
      data: [
        {
          ...sampleOrder,
          status: "partially_filled",
          filled_quantity: "0.0005",
          average_fill_price: "94500",
        },
      ],
    });
    await program.parseAsync(["node", "revx", "order", "history"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("Avg Fill Price");
    expect(output).toContain("94500");
  });

  it("shows empty message when no history found", async () => {
    mockGetHistoricalOrders.mockResolvedValue({ data: [] });
    await program.parseAsync(["node", "revx", "order", "history"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("No order history found");
  });

  it("outputs JSON when --json is set", async () => {
    await program.parseAsync(["node", "revx", "order", "history", "--json"]);
    const output = logSpy.mock.calls.flat().join(" ");
    const parsed = JSON.parse(output);
    expect(parsed.data[0].status).toBe("filled");
  });

  it("fetches all pages automatically within a date window", async () => {
    const orderA = { ...sampleOrder, id: "order-page1", status: "filled" };
    const orderB = { ...sampleOrder, id: "order-page2", status: "filled" };
    mockGetHistoricalOrders.mockResolvedValue({
      data: [orderA, orderB],
      metadata: {},
    });
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "history",
      "--start-date",
      "1715000000000",
      "--end-date",
      "1715086400000",
    ]);
    expect(mockGetHistoricalOrders).toHaveBeenCalled();
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("order-page1");
    expect(output).toContain("order-page2");
  });

  it("handles long date ranges", async () => {
    const startMs = 1715040000000; // 2024-05-07
    const endMs = startMs + 61 * 24 * 60 * 60 * 1000; // 61 days

    mockGetHistoricalOrders.mockResolvedValue({
      data: [{ ...sampleOrder, status: "filled" }],
      metadata: {},
    });

    await program.parseAsync([
      "node",
      "revx",
      "order",
      "history",
      "--start-date",
      String(startMs),
      "--end-date",
      String(endMs),
    ]);

    expect(mockGetHistoricalOrders).toHaveBeenCalled();
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("order-123");
  });

  it("displays created timestamp in the output", async () => {
    await program.parseAsync(["node", "revx", "order", "history"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain(formatLocalDateTime(1700000000000));
  });
});

describe("order get", () => {
  let program: Command;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = makeProgram();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    mockGetOrder.mockResolvedValue({ data: sampleOrder });
  });

  afterEach(() => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("fetches order details by ID", async () => {
    await program.parseAsync(["node", "revx", "order", "get", "order-123"]);
    expect(mockGetOrder).toHaveBeenCalledWith("order-123");
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("order-123");
  });

  it("outputs JSON when --json is set", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "get",
      "order-123",
      "--json",
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    const parsed = JSON.parse(output);
    expect(parsed.data.id).toBe("order-123");
  });

  it("displays total_fee and fee_currency when present", async () => {
    mockGetOrder.mockResolvedValue({
      data: { ...sampleOrder, total_fee: "0.95", fee_currency: "USD" },
    });
    await program.parseAsync(["node", "revx", "order", "get", "order-123"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("0.95");
    expect(output).toContain("USD");
  });

  it("displays amount and filled_amount when present", async () => {
    mockGetOrder.mockResolvedValue({
      data: { ...sampleOrder, amount: "100", filled_amount: "95" },
    });
    await program.parseAsync(["node", "revx", "order", "get", "order-123"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("100");
    expect(output).toContain("95");
  });

  it("displays avg fill price when present", async () => {
    mockGetOrder.mockResolvedValue({
      data: { ...sampleOrder, average_fill_price: "94800" },
    });
    await program.parseAsync(["node", "revx", "order", "get", "order-123"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("Avg Fill Price");
    expect(output).toContain("94800");
  });

  it("displays twap details for twap parent order", async () => {
    mockGetOrder.mockResolvedValue({
      data: {
        ...sampleTwapOrder,
        twap: {
          ...sampleTwapOrder.twap,
          linked_ids: ["child-order-1", "child-order-2"],
        },
      },
    });
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "get",
      "twap-order-456",
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("TWAP Details");
    expect(output).toContain("market");
    expect(output).toContain("300s");
    expect(output).toContain("30s");
    expect(output).toContain("10");
    expect(output).toContain("Linked Order IDs");
    expect(output).toContain("child-order-1");
    expect(output).toContain("child-order-2");
  });

  it("displays twap limit price when present", async () => {
    mockGetOrder.mockResolvedValue({
      data: {
        ...sampleTwapOrder,
        twap: {
          ...sampleTwapOrder.twap,
          type: "limit",
          price: "10.10",
          linked_ids: ["child-1"],
        },
      },
    });
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "get",
      "twap-order-456",
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("limit");
    expect(output).toContain("10.10");
  });

  it("displays triggered_by twap for twap slice order", async () => {
    mockGetOrder.mockResolvedValue({
      data: {
        ...sampleOrder,
        triggered_by: {
          twap: {
            parent_id: "twap-parent-789",
            slice_index: 3,
          },
          reason: "twap",
        },
      },
    });
    await program.parseAsync(["node", "revx", "order", "get", "order-123"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("Triggered By");
    expect(output).toContain("twap");
    expect(output).toContain("TWAP Trigger");
    expect(output).toContain("twap-parent-789");
    expect(output).toContain("3");
  });
});

describe("order cancel", () => {
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
    mockCancelOrder.mockResolvedValue(undefined);
    mockCancelAllOrders.mockResolvedValue(undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("prints a small JSON document for a cancel", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "cancel",
      "order-123",
      "--json",
    ]);

    expect(JSON.parse(logSpy.mock.calls.flat().join(""))).toEqual({
      cancelled: "order-123",
    });
  });

  it("prints a small JSON document for cancel --all", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "cancel",
      "--all",
      "--output",
      "json",
    ]);

    expect(JSON.parse(logSpy.mock.calls.flat().join(""))).toEqual({
      cancelled: "all",
    });
  });

  it("cancels a specific order by ID", async () => {
    await program.parseAsync(["node", "revx", "order", "cancel", "order-123"]);
    expect(mockCancelOrder).toHaveBeenCalledWith("order-123");
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("order-123");
  });

  it("cancels all orders with --all flag", async () => {
    await program.parseAsync(["node", "revx", "order", "cancel", "--all"]);
    expect(mockCancelAllOrders).toHaveBeenCalledOnce();
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("All open orders cancelled");
  });

  it("exits with error when no order ID and no --all", async () => {
    await expect(
      program.parseAsync(["node", "revx", "order", "cancel"]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with error when both order ID and --all are provided", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "cancel",
        "order-123",
        "--all",
      ]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("order replace", () => {
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
    mockReplaceOrder.mockResolvedValue({
      data: {
        venue_order_id: "new-order-999",
        client_order_id: "client-new",
        state: "new",
      },
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  function answer(state: string) {
    mockReplaceOrder.mockResolvedValue({
      data: {
        venue_order_id: "new-order-999",
        client_order_id: "client-new",
        state,
      },
    });
  }

  it("checks a new price against the step of the order's own pair", async () => {
    mockGetOrder.mockResolvedValue({ data: { symbol: "BTC-USD" } });

    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "replace",
        "order-1",
        "--price",
        "95000.015",
      ]),
    ).rejects.toThrow("process.exit");

    expect(mockGetOrder).toHaveBeenCalledWith("order-1");
    expect(errSpy.mock.calls.flat().join(" ")).toContain(
      "--price 95000.015 is not a multiple of the BTC-USD price step 0.01.",
    );
    expect(mockReplaceOrder).not.toHaveBeenCalled();
  });

  it("names the pair the way the CLI writes it when the order says BTC/USD", async () => {
    mockGetOrder.mockResolvedValue({ data: { symbol: "BTC/USD" } });

    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "replace",
        "order-1",
        "--price",
        "95000.015",
      ]),
    ).rejects.toThrow("process.exit");

    expect(errSpy.mock.calls.flat().join(" ")).toContain(
      "the BTC-USD price step 0.01",
    );
  });

  it("lets the exchange decide when it doesn't list the order yet", async () => {
    const { NotFoundError } = await import("@revolut/revolut-x-api");
    mockGetOrder.mockRejectedValue(new NotFoundError("Order not found"));

    await program.parseAsync([
      "node",
      "revx",
      "order",
      "replace",
      "order-1",
      "--price",
      "95000.01",
    ]);

    expect(mockGetCurrencyPairs).not.toHaveBeenCalled();
    expect(mockReplaceOrder).toHaveBeenCalledWith(
      "order-1",
      expect.objectContaining({ price: "95000.01" }),
    );
  });

  it("refuses an empty --price instead of ignoring it", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "replace",
        "order-1",
        "--price",
        "",
        "--qty",
        "1",
      ]),
    ).rejects.toThrow("process.exit");

    expect(mockReplaceOrder).not.toHaveBeenCalled();
  });

  it("replaces with a price on the step", async () => {
    mockGetOrder.mockResolvedValue({ data: { symbol: "BTC-USD" } });

    await program.parseAsync([
      "node",
      "revx",
      "order",
      "replace",
      "order-1",
      "--price",
      "95000.01",
    ]);

    expect(mockReplaceOrder).toHaveBeenCalledWith(
      "order-1",
      expect.objectContaining({ price: "95000.01" }),
    );
  });

  it("names --qty when it is not a number and reads nothing", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "replace",
        "order-1",
        "--qty",
        "0x10",
      ]),
    ).rejects.toThrow("process.exit");

    expect(errSpy.mock.calls.flat().join(" ")).toContain(
      '--qty must be a positive number, got "0x10".',
    );
    expect(mockGetOrder).not.toHaveBeenCalled();
    expect(mockReplaceOrder).not.toHaveBeenCalled();
  });

  it("reports a rejected replacement as an error and says the original is gone", async () => {
    answer("rejected");

    await program.parseAsync([
      "node",
      "revx",
      "order",
      "replace",
      "order-123",
      "--price",
      "96000",
    ]);

    expect(errSpy.mock.calls.flat().join(" ")).toContain(
      "The exchange rejected the replacement. A replace cancels the original order order-123 first, so neither order is open now.",
    );
    expect(process.exitCode).toBe(1);
  });

  it("says a replacement whose reply was lost may have been placed", async () => {
    mockReplaceOrder.mockRejectedValue(
      new NetworkError("No reply from the exchange: UND_ERR_SOCKET.", {
        mayHaveReachedServer: true,
      }),
    );

    await program.parseAsync([
      "node",
      "revx",
      "order",
      "replace",
      "order-123",
      "--price",
      "96000",
      "--client-order-id",
      "c-chosen",
    ]);

    const errors = errSpy.mock.calls.flat().join("\n");
    expect(errors).toContain("The replacement may have been placed.");
    expect(errors).toContain(
      "If revx order get order-123 shows the original still open, the replace didn't happen and can be run again.",
    );
    expect(errors).toContain("--client-order-id c-chosen");
    expect(process.exitCode).toBe(1);
  });

  it("names the post-only cause of a rejected post-only replacement", async () => {
    answer("rejected");

    await program.parseAsync([
      "node",
      "revx",
      "order",
      "replace",
      "order-123",
      "--price",
      "96000",
      "--post-only",
    ]);

    expect(errSpy.mock.calls.flat().join(" ")).toContain(
      "A post-only order is usually rejected because its price would trade at once.",
    );
  });

  it("keeps the JSON document of a rejected replacement and exits 1", async () => {
    answer("rejected");

    await program.parseAsync([
      "node",
      "revx",
      "order",
      "replace",
      "order-123",
      "--price",
      "96000",
      "--json",
    ]);

    expect(JSON.parse(logSpy.mock.calls.flat().join(" ")).data.state).toBe(
      "rejected",
    );
    expect(process.exitCode).toBe(1);
  });

  it("reports an accepted replacement as replaced", async () => {
    answer("new");

    await program.parseAsync([
      "node",
      "revx",
      "order",
      "replace",
      "order-123",
      "--price",
      "96000",
    ]);

    expect(logSpy.mock.calls.flat().join(" ")).toContain("✓ Order replaced.");
    expect(process.exitCode).toBeUndefined();
  });

  it("warns, without failing, when an IOC replacement closed at once", async () => {
    answer("cancelled");

    await program.parseAsync([
      "node",
      "revx",
      "order",
      "replace",
      "order-123",
      "--time-in-force",
      "ioc",
    ]);

    expect(logSpy.mock.calls.flat().join(" ")).toContain(
      "Order replaced by an IOC order that closed at once.",
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("replaces order with --qty", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "replace",
      "order-123",
      "--qty",
      "0.002",
      "--client-order-id",
      "client-new",
    ]);
    expect(mockReplaceOrder).toHaveBeenCalledWith("order-123", {
      clientOrderId: "client-new",
      baseSize: "0.002",
    });
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("new-order-999");
  });

  it("replaces order with --price", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "replace",
      "order-123",
      "--price",
      "96000",
      "--client-order-id",
      "client-new",
    ]);
    expect(mockReplaceOrder).toHaveBeenCalledWith("order-123", {
      clientOrderId: "client-new",
      price: "96000",
    });
  });

  it("replaces order with --quote", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "replace",
      "order-123",
      "--quote",
      "150",
      "--client-order-id",
      "client-new",
    ]);
    expect(mockReplaceOrder).toHaveBeenCalledWith("order-123", {
      clientOrderId: "client-new",
      quoteSize: "150",
    });
  });

  it("replaces order with --allow-taker explicitly", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "replace",
      "order-123",
      "--allow-taker",
      "--client-order-id",
      "client-new",
    ]);
    expect(mockReplaceOrder).toHaveBeenCalledWith("order-123", {
      clientOrderId: "client-new",
      executionInstructions: ["allow_taker"],
    });
  });

  it("replaces order with --post-only", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "replace",
      "order-123",
      "--post-only",
      "--client-order-id",
      "client-new",
    ]);
    expect(mockReplaceOrder).toHaveBeenCalledWith("order-123", {
      clientOrderId: "client-new",
      executionInstructions: ["post_only"],
    });
  });

  it("replaces order with --time-in-force alongside --price", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "replace",
      "order-123",
      "--price",
      "96000",
      "--time-in-force",
      "ioc",
      "--client-order-id",
      "client-new",
    ]);
    expect(mockReplaceOrder).toHaveBeenCalledWith("order-123", {
      clientOrderId: "client-new",
      price: "96000",
      timeInForce: "ioc",
    });
  });

  it("replaces order with only --time-in-force", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "replace",
      "order-123",
      "--time-in-force",
      "gtc",
      "--client-order-id",
      "client-new",
    ]);
    expect(mockReplaceOrder).toHaveBeenCalledWith("order-123", {
      clientOrderId: "client-new",
      timeInForce: "gtc",
    });
  });

  it("auto-generates client-order-id when omitted", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "replace",
      "order-123",
      "--qty",
      "0.002",
    ]);
    const call = mockReplaceOrder.mock.calls[0];
    expect(call[0]).toBe("order-123");
    expect(typeof call[1].clientOrderId).toBe("string");
    expect(call[1].clientOrderId.length).toBeGreaterThan(0);
    expect(call[1].baseSize).toBe("0.002");
  });

  it("exits when --post-only is combined with --time-in-force ioc", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "replace",
        "order-123",
        "--post-only",
        "--time-in-force",
        "ioc",
      ]),
    ).rejects.toThrow("process.exit");
    expect(mockReplaceOrder).not.toHaveBeenCalled();
    const output = errSpy.mock.calls.flat().join(" ");
    expect(output).toContain("--post-only cannot be combined");
  });

  it("exits when no replaceable field given", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "replace",
        "order-123",
        "--client-order-id",
        "client-new",
      ]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when both --qty and --quote are provided", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "replace",
        "order-123",
        "--qty",
        "0.001",
        "--quote",
        "100",
      ]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when both --post-only and --allow-taker are provided", async () => {
    await expect(
      program.parseAsync([
        "node",
        "revx",
        "order",
        "replace",
        "order-123",
        "--post-only",
        "--allow-taker",
      ]),
    ).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("order fills", () => {
  let program: Command;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  const sampleFill = {
    id: "fill-1",
    symbol: "BTC-USD",
    side: "buy",
    price: "95000",
    quantity: "0.001",
    maker: false,
    timestamp: 1700000000000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    program = makeProgram();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    mockGetOrderFills.mockResolvedValue({ data: [sampleFill] });
  });

  afterEach(() => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("fetches fills for a given order ID", async () => {
    await program.parseAsync(["node", "revx", "order", "fills", "order-123"]);
    expect(mockGetOrderFills).toHaveBeenCalledWith("order-123");
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("fill-1");
  });

  it("shows empty message when no fills found", async () => {
    mockGetOrderFills.mockResolvedValue({ data: [] });
    await program.parseAsync(["node", "revx", "order", "fills", "order-123"]);
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toContain("No fills found");
  });

  it("outputs JSON when --json is set", async () => {
    await program.parseAsync([
      "node",
      "revx",
      "order",
      "fills",
      "order-123",
      "--json",
    ]);
    const output = logSpy.mock.calls.flat().join(" ");
    const parsed = JSON.parse(output);
    expect(parsed.data[0].id).toBe("fill-1");
  });
});

describe("order help", () => {
  function helpOf(name: string): string {
    const program = new Command();
    registerOrderCommand(program);
    const command = program.commands
      .find((candidate) => candidate.name() === "order")!
      .commands.find((candidate) => candidate.name() === name)!;
    let help = "";
    command.configureOutput({ writeOut: (text) => (help += text) });
    command.outputHelp();
    return help;
  }

  it("says what a price-only replace keeps", () => {
    expect(helpOf("replace")).toContain(
      "Changing only --price keeps a buy's quote amount (its quantity changes) and a",
    );
  });

  it.each(["place", "replace"])(
    "tells scripts to pass their own client order ID in %s",
    (name) => {
      expect(helpOf(name)).toContain(
        "Scripts: pass your own --client-order-id <uuid> to know the ID even if the",
      );
    },
  );
});
