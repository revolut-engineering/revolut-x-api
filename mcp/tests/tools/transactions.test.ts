import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { vi, describe, beforeEach, it, expect } from "vitest";
import { registerTransactionTools } from "../../src/tools/transactions.js";

const mockClient = {
  getTransactions: vi.fn(),
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
  source_currency: "USD",
  source_amount: "1.00",
  destination_currency: "BTC",
  destination_amount: "0.00001564",
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

    expect(text).toContain("Source Amount: -1.00 USD");
    expect(text).toContain("Destination Amount: +0.00001564 BTC");
    expect(text).toContain("Processed:");
    expect(getTransactions(result)).toEqual([buyTransaction]);
  });

  it("formats a destination-only transaction", async () => {
    const receiveTransaction = {
      id: "receive-1",
      status: "completed",
      type: "receive",
      destination_currency: "USD",
      destination_amount: "14.70",
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
      source_currency: "BTC",
      source_amount: "0.005",
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

    expect(text).toContain("Source Amount: -0.005 BTC");
    expect(text).not.toContain("Destination Amount:");
  });

  it("passes filters to the API", async () => {
    const client = await createClient();
    await client.callTool({
      name: "get_transactions",
      arguments: {
        start_date: "2026-08-01",
        end_date: "2026-08-02",
        types: ["buy", "receive"],
        statuses: ["completed"],
        currencies: ["btc", "usd"],
        totalLimit: 50,
      },
    });

    expect(mockClient.getTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: expect.any(Number),
        endDate: expect.any(Number),
        types: ["buy", "receive"],
        statuses: ["completed"],
        currencies: ["BTC", "USD"],
        cursor: undefined,
        limit: expect.any(Number),
      }),
    );
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
