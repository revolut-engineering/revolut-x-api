import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { vi, describe, beforeEach, it, expect } from "vitest";
import { registerTransactionTools } from "../../src/tools/transactions.js";

const mockClient = {
  getTransactions: vi.fn(),
  getTransaction: vi.fn(),
};

vi.mock("../../src/server.js", () => ({
  getRevolutXClient: vi.fn(() => mockClient),
  SETUP_GUIDE: "Setup guide text",
}));

vi.mock("@revolut/revolut-x-api", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  class AuthNotConfiguredError extends Error {
    name = "AuthNotConfiguredError";
  }
  return {
    ...actual,
    AuthNotConfiguredError,
  };
});

const buyTransaction = {
  id: "buy-1",
  status: "completed",
  type: "buy",
  source: {
    amount: "1.00",
    currency: "USD",
    account: { type: "revolut_x" },
  },
  destination: {
    amount: "0.00001564",
    currency: "BTC",
    account: { type: "revolut_x" },
  },
  created_date: 1786607516938,
  processed_date: 1786607517180,
};

const buyTransactionDetails = {
  id: "buy-1",
  status: "completed",
  type: "buy",
  source: {
    amount: "1.00",
    currency: "USD",
    fee: "0.001",
    fee_currency: "USD",
    account: {
      type: "revolut_x",
      display_name: "Crypto Primary",
    },
  },
  destination: {
    amount: "0.00001564",
    currency: "BTC",
    account: {
      type: "revolut_x",
      display_name: "Crypto Primary",
    },
  },
  order_id: "order-123",
  description: "Bought via Revolut X",
  created_date: 1786607516938,
  processed_date: 1786607517180,
};

async function createClient(): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  registerTransactionTools(server);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);
  return client;
}

function getText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  if (!("content" in result)) return "";
  const content = result.content as Array<{ type: string; text?: string }>;
  return content[0]?.text ?? "";
}

function getTransactions(
  result: Awaited<ReturnType<Client["callTool"]>>,
): Array<Record<string, unknown>> {
  if (!("structuredContent" in result)) return [];
  const content = result.structuredContent as {
    transactions?: Array<Record<string, unknown>>;
  };
  return content.transactions ?? [];
}

describe("transaction tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.getTransactions.mockResolvedValue({
      data: [buyTransaction],
      metadata: {},
    });
  });

  it("formats both sides as signed source and destination amounts", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "get_transactions",
      arguments: {},
    });
    const text = getText(result);

    expect(text).toContain("Source Amount: -1.00 USD (revolut_x)");
    expect(text).toContain("Destination Amount: +0.00001564 BTC (revolut_x)");
    expect(text).toContain("Processed:");
    expect(getTransactions(result)).toEqual([buyTransaction]);
  });

  it("reports per-leg account types on a sell", async () => {
    const sellTransaction = {
      id: "sell-1",
      status: "completed",
      type: "sell",
      source: {
        amount: "0.01",
        currency: "BTC",
        account: { type: "revolut_x" },
      },
      destination: {
        amount: "100.00",
        currency: "USD",
        account: { type: "revolut" },
      },
      created_date: 1786607516938,
      processed_date: 1786607517180,
    };
    mockClient.getTransactions.mockResolvedValue({
      data: [sellTransaction],
      metadata: {},
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "get_transactions",
      arguments: {},
    });
    const text = getText(result);

    expect(text).toContain("Source Amount: -0.01 BTC (revolut_x)");
    expect(text).toContain("Destination Amount: +100.00 USD (revolut)");
    expect(getTransactions(result)).toEqual([sellTransaction]);
  });

  it("formats a destination-only transaction", async () => {
    const receiveTransaction = {
      id: "receive-1",
      status: "completed",
      type: "receive",
      destination: {
        amount: "14.70",
        currency: "USD",
      },
      created_date: 1786606457673,
      processed_date: 1786606457675,
    };
    mockClient.getTransactions.mockResolvedValue({
      data: [receiveTransaction],
      metadata: {},
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "get_transactions",
      arguments: {},
    });
    const text = getText(result);

    expect(text).not.toContain("Source Amount:");
    expect(text).toContain("Destination Amount: +14.70 USD");
  });

  it("formats a source-only transaction", async () => {
    const sendTransaction = {
      id: "send-1",
      status: "completed",
      type: "send",
      source: {
        amount: "0.005",
        currency: "BTC",
      },
      created_date: 1786606457673,
      processed_date: 1786606457675,
    };
    mockClient.getTransactions.mockResolvedValue({
      data: [sendTransaction],
      metadata: {},
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "get_transactions",
      arguments: {},
    });
    const text = getText(result);

    expect(text).toContain("Source Amount: -0.005 BTC\n");
    expect(text).not.toContain("Destination Amount:");
  });

  it("passes filters to the API", async () => {
    const client = await createClient();
    await client.callTool({
      name: "get_transactions",
      arguments: {
        start_date: "2026-08-01",
        end_date: "2026-08-02",
        types: ["stake", "un_stake", "reward"],
        statuses: ["completed", "cancelled"],
        currencies: ["btc", "usd"],
        totalLimit: 50,
      },
    });

    expect(mockClient.getTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: expect.any(Number),
        endDate: expect.any(Number),
        types: ["stake", "un_stake", "reward"],
        statuses: ["completed", "cancelled"],
        currencies: ["BTC", "USD"],
        cursor: undefined,
        limit: expect.any(Number),
      }),
    );
  });

  it("rejects the US spelling canceled for statuses", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "get_transactions",
      arguments: { statuses: ["canceled"] },
    });

    expect(result.isError).toBe(true);
    expect(mockClient.getTransactions).not.toHaveBeenCalled();
  });

  it("fetches all cursor pages", async () => {
    const receiveTransaction = {
      ...buyTransaction,
      id: "receive-2",
      type: "receive",
    };
    mockClient.getTransactions
      .mockResolvedValueOnce({
        data: [buyTransaction],
        metadata: { next_cursor: "next-page" },
      })
      .mockResolvedValueOnce({
        data: [receiveTransaction],
        metadata: {},
      });
    const client = await createClient();
    const result = await client.callTool({
      name: "get_transactions",
      arguments: { totalLimit: 2 },
    });

    expect(mockClient.getTransactions).toHaveBeenCalledTimes(2);
    expect(mockClient.getTransactions).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: "next-page" }),
    );
    expect(getTransactions(result)).toHaveLength(2);
  });

  it("returns an empty structured result", async () => {
    mockClient.getTransactions.mockResolvedValue({ data: [], metadata: {} });
    const client = await createClient();
    const result = await client.callTool({
      name: "get_transactions",
      arguments: {},
    });

    expect(getText(result)).toContain("No transactions found");
    expect(getTransactions(result)).toEqual([]);
  });

  it("returns the setup guide on an authentication error", async () => {
    const { AuthNotConfiguredError } = await import("@revolut/revolut-x-api");
    mockClient.getTransactions.mockRejectedValue(
      new AuthNotConfiguredError("not configured"),
    );
    const client = await createClient();
    const result = await client.callTool({
      name: "get_transactions",
      arguments: {},
    });

    expect(getText(result)).toContain("Setup guide text");
  });
});

describe("get_transaction tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.getTransaction.mockResolvedValue(buyTransactionDetails);
  });

  it("fetches the transaction by id and returns structured details", async () => {
    const client = await createClient();
    const result = await client.callTool({
      name: "get_transaction",
      arguments: { transaction_id: "buy-1" },
    });

    expect(mockClient.getTransaction).toHaveBeenCalledWith("buy-1");
    const text = getText(result);
    expect(text).toContain("Transaction buy-1");
    expect(text).toContain("Source Amount: -1.00 USD");
    expect(text).toContain("Fee: 0.001 USD");
    expect(text).toContain("Account: Crypto Primary · revolut_x");
    expect(text).toContain("Destination Amount: +0.00001564 BTC");
    expect(text).toContain("Order ID: order-123");
    expect(text).toContain("Description: Bought via Revolut X");

    if (!("structuredContent" in result)) throw new Error("missing");
    expect(
      (result.structuredContent as Record<string, unknown>).transaction,
    ).toEqual(buyTransactionDetails);
  });

  it("shows on-chain fields when present", async () => {
    mockClient.getTransaction.mockResolvedValue({
      ...buyTransactionDetails,
      type: "send",
      source: {
        amount: "0.5",
        currency: "ETH",
        account: {
          type: "revolut_x",
          display_name: "Crypto Primary",
        },
      },
      destination: {
        amount: "0.5",
        currency: "ETH",
        account: {
          type: "external_crypto",
        },
      },
      order_id: undefined,
      crypto_transaction_hash: "0xabc123",
      network: "Ethereum",
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "get_transaction",
      arguments: { transaction_id: "buy-1" },
    });
    const text = getText(result);

    expect(text).toContain("Source Amount: -0.5 ETH");
    expect(text).toContain("Account: Crypto Primary · revolut_x");
    expect(text).toContain("Account: external_crypto");
    expect(text).toContain("Crypto Transaction Hash: 0xabc123");
    expect(text).toContain("Network: Ethereum");
    expect(text).not.toContain("Order ID:");
  });

  it("shows the crypto address of an external wallet account", async () => {
    mockClient.getTransaction.mockResolvedValue({
      ...buyTransactionDetails,
      type: "send",
      destination: {
        amount: "0.5",
        currency: "ETH",
        fee: "0.0001",
        fee_currency: "ETH",
        account: {
          type: "external_crypto",
          display_name: "External Wallet",
          crypto_address: "0xdeadbeef",
        },
      },
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "get_transaction",
      arguments: { transaction_id: "buy-1" },
    });
    const text = getText(result);

    expect(text).toContain(
      "Account: External Wallet · external_crypto · 0xdeadbeef",
    );
  });

  it("shows a sub-account as the leg account", async () => {
    mockClient.getTransaction.mockResolvedValue({
      ...buyTransactionDetails,
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
    const client = await createClient();
    const result = await client.callTool({
      name: "get_transaction",
      arguments: { transaction_id: "buy-1" },
    });
    const text = getText(result);

    expect(text).toContain("Account: My X Account · revolut_x");
  });

  it("omits optional fields that are absent", async () => {
    mockClient.getTransaction.mockResolvedValue({
      id: "reward-1",
      status: "completed",
      type: "reward",
      destination: { amount: "0.0001", currency: "ETH" },
      created_date: 1786607516938,
    });
    const client = await createClient();
    const result = await client.callTool({
      name: "get_transaction",
      arguments: { transaction_id: "reward-1" },
    });
    const text = getText(result);

    expect(text).toContain("Destination Amount: +0.0001 ETH");
    expect(text).not.toContain("Fee:");
    expect(text).not.toContain("Order ID:");
    expect(text).not.toContain("Description:");
    expect(text).not.toContain("Processed:");
  });

  it("returns the setup guide on an authentication error", async () => {
    const { AuthNotConfiguredError } = await import("@revolut/revolut-x-api");
    mockClient.getTransaction.mockRejectedValue(
      new AuthNotConfiguredError("not configured"),
    );
    const client = await createClient();
    const result = await client.callTool({
      name: "get_transaction",
      arguments: { transaction_id: "buy-1" },
    });

    expect(getText(result)).toContain("Setup guide text");
  });
});
